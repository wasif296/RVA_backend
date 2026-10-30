import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';
import {
  assertQuizDocumentsIntegrity,
  Badge,
  Course,
  ExamSubmission,
  InviteToken,
  Lesson,
  Notification,
  Progress,
  Quiz,
  QuizAttempt,
  RefreshToken,
  User,
} from '../models/index.js';
import { RULES } from '../shared/index.js';
import { migrateQuizFinalExams } from './migrate-quiz-final-exams.js';

function requireSeedEnv(name: 'SEED_ADMIN_EMAIL' | 'SEED_ADMIN_PASSWORD'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run the seed script`);
  }
  return value;
}

/** Random correctIndex per question — never a predictable A-B-C-D cycle. */
export function buildQuestions(prefix: string) {
  return Array.from({ length: 10 }, (_, index) => {
    const order = index + 1;
    return {
      text: `${prefix} — question ${order}`,
      options: [
        `Option A for Q${order}`,
        `Option B for Q${order}`,
        `Option C for Q${order}`,
        `Option D for Q${order}`,
      ],
      correctIndex: randomInt(0, 4),
      order,
    };
  });
}

export type SeedResult = {
  adminEmail: string;
  testUserEmail: string;
  courseId: string;
  courseSlug: string;
  lessonIds: string[];
  lessonQuizLessonIds: string[];
  quizlessLessonId: string;
  finalExamId: string;
  finalExamTotal: number;
  lessonCount: number;
};

/**
 * Wipe LMS collections and insert the Phase 8 demo course.
 * Caller must already be connected to MongoDB.
 */
export async function seedDatabase(): Promise<SeedResult> {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to run seed in production');
  }

  const adminEmail = requireSeedEnv('SEED_ADMIN_EMAIL');
  const adminPassword = requireSeedEnv('SEED_ADMIN_PASSWORD');

  await Promise.all([
    User.deleteMany({}),
    Course.deleteMany({}),
    Lesson.deleteMany({}),
    Quiz.deleteMany({}),
    Progress.deleteMany({}),
    QuizAttempt.deleteMany({}),
    ExamSubmission.deleteMany({}),
    Badge.deleteMany({}),
    Notification.deleteMany({}),
    RefreshToken.deleteMany({}),
    InviteToken.deleteMany({}),
  ]);

  // Drop leftover unique indexes (e.g. lessonId_1) before inserting exams.
  await migrateQuizFinalExams();

  const adminPasswordHash = await argon2.hash(adminPassword, {
    type: argon2.argon2id,
  });
  const testPasswordHash = await argon2.hash('ChangeMeNow!', {
    type: argon2.argon2id,
  });

  const admin = await User.create({
    name: 'RVA Super Admin',
    email: adminEmail,
    passwordHash: adminPasswordHash,
    role: 'super_admin',
    isActive: true,
    mustChangePassword: false,
  });

  const testUser = await User.create({
    name: 'Test Learner',
    email: 'learner@rva.test',
    passwordHash: testPasswordHash,
    role: 'user',
    isActive: true,
    mustChangePassword: true,
    createdBy: admin._id,
  });

  const course = await Course.create({
    title: 'Remote VA Foundations',
    slug: 'remote-va-foundations',
    description:
      'Core skills for remote virtual assistants: communication, tools, and client workflows.',
    thumbnailUrl: 'https://example.com/thumbnails/remote-va-foundations.jpg',
    category: 'Foundations',
    level: 'beginner',
    status: 'published',
    lessonCount: 3,
    totalDurationSec: 1080,
    createdBy: admin._id,
  });

  const lessons = await Lesson.insertMany([
    {
      courseId: course._id,
      title: 'Working remotely with confidence',
      description: 'Mindset, workspace setup, and professional presence online.',
      youtubeVideoId: 'M7lc1UVf-VE',
      durationSec: 360,
      order: 10,
    },
    {
      courseId: course._id,
      title: 'Inbox and calendar mastery',
      description: 'Triage email, protect focus time, and run a clean calendar.',
      youtubeVideoId: 'aqz-KE-bpKQ',
      durationSec: 420,
      order: 20,
    },
    {
      courseId: course._id,
      title: 'Client communication basics',
      description: 'Clear updates, boundaries, and async collaboration habits.',
      youtubeVideoId: 'jNQXAC9IVRw',
      durationSec: 300,
      order: 30,
    },
  ]);

  const [lesson1, lesson2, lesson3] = lessons;
  if (!lesson1 || !lesson2 || !lesson3) {
    throw new Error('Expected three seeded lessons');
  }

  // insertMany must validate scope/courseId (see Quiz pre('insertMany')).
  const quizzes = await Quiz.insertMany([
    {
      scope: 'lesson',
      courseId: course._id,
      lessonId: lesson1._id,
      title: 'Remote work check-in',
      pointsPerQuestion: 1,
      passingScorePct: 70,
      maxAttempts: null,
      questions: buildQuestions('Remote work'),
    },
    {
      scope: 'lesson',
      courseId: course._id,
      lessonId: lesson2._id,
      title: 'Inbox and calendar check-in',
      pointsPerQuestion: 1,
      passingScorePct: 70,
      maxAttempts: null,
      questions: buildQuestions('Inbox and calendar'),
    },
  ]);

  // Written final exam — fixed 50 marks, text questions only (tutor-graded later).
  const finalExam = await Quiz.create({
    scope: 'final_exam',
    courseId: course._id,
    lessonId: null,
    title: 'Remote VA Foundations — Final Exam',
    instructions:
      'Answer all questions in a Google Doc, then submit the doc link (and optional Loom walkthrough). A tutor will grade your work out of 50.',
    pointsPerQuestion: RULES.DEFAULT_POINTS_PER_QUESTION,
    passingScorePct: RULES.FINAL_EXAM_PASS_PCT,
    maxAttempts: null,
    questions: [
      {
        text: 'Describe how you would set up a professional remote workspace for client-facing work.',
        options: [],
        order: 10,
      },
      {
        text: 'Outline a daily inbox triage process that protects focus time while keeping response SLAs.',
        options: [],
        order: 20,
      },
      {
        text: 'Write a short async status update to a client after completing a calendar cleanup.',
        options: [],
        order: 30,
      },
    ],
  });

  await assertQuizDocumentsIntegrity();

  const finalExamTotal = RULES.FINAL_EXAM_MAX_MARKS;
  const result: SeedResult = {
    adminEmail: admin.email,
    testUserEmail: testUser.email,
    courseId: course._id.toString(),
    courseSlug: course.slug,
    lessonIds: lessons.map((l) => l._id.toString()),
    lessonQuizLessonIds: [lesson1._id.toString(), lesson2._id.toString()],
    quizlessLessonId: lesson3._id.toString(),
    finalExamId: finalExam._id.toString(),
    finalExamTotal,
    lessonCount: lessons.length,
  };

  logger.info(
    {
      adminEmail: result.adminEmail,
      testUserEmail: result.testUserEmail,
      courseSlug: result.courseSlug,
      lessonCount: result.lessonCount,
      quizCount: quizzes.length,
      quizLessons: [lesson1.order, lesson2.order],
      quizlessLessonOrder: lesson3.order,
      finalExamId: result.finalExamId,
      finalExamTotal: result.finalExamTotal,
    },
    'Seed complete',
  );

  console.log('Seed summary');
  console.log(`- Super admin: ${admin.email}`);
  console.log(`- Test user: ${testUser.email} (mustChangePassword=true)`);
  console.log(`- Course: ${course.title} (${course.slug})`);
  console.log(`- Lessons: ${lessons.length} (orders 10, 20, 30)`);
  console.log(`- Lesson quizzes: ${quizzes.length} on lessons 10 and 20; lesson 30 has none`);
  console.log(
    `- Final exam: ${finalExam.title} (${finalExam.questions.length} text questions, ${finalExamTotal} max marks)`,
  );

  return result;
}

async function main(): Promise<void> {
  await connectDatabase();
  await seedDatabase();
}

const invokedAsCli = /(?:^|[/\\])seed\.(ts|js)$/.test(process.argv[1] ?? '');

if (invokedAsCli) {
  main()
    .then(async () => {
      await disconnectDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      try {
        await disconnectDatabase();
      } catch {
        // ignore disconnect errors during failure cleanup
      }
      process.exit(1);
    });
}
