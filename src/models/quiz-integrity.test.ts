import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { RULES } from '@shared';
import {
  assertQuizDocumentsIntegrity,
  Course,
  Lesson,
  finalExamFilter,
  lessonQuizFilter,
  Progress,
  Quiz,
  User,
} from '../models/index.js';
import { getLessonLearningDetail } from '../modules/lessons/lessons.service.js';
import { getLessonQuizForAdmin } from '../modules/quiz/quiz.service.js';
import {
  assertNoStaleQuizIndexes,
  migrateQuizFinalExams,
} from '../scripts/migrate-quiz-final-exams.js';
import { seedDatabase } from '../scripts/seed.js';

describe('Quiz integrity — scope/courseId + seed', () => {
  let mongod: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Quiz.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Course.deleteMany({}),
      Lesson.deleteMany({}),
      Quiz.deleteMany({}),
      Progress.deleteMany({}),
    ]);
  });

  async function createCourseAndLesson() {
    const admin = await User.create({
      name: 'Admin',
      email: `admin-${Date.now()}@test.local`,
      passwordHash: 'hash',
      role: 'super_admin',
    });
    const course = await Course.create({
      title: 'Integrity Course',
      slug: `integrity-${admin._id.toString()}`,
      description: 'Quiz integrity fixtures',
      category: 'Test',
      level: 'beginner',
      status: 'published',
      createdBy: admin._id,
    });
    const lesson = await Lesson.create({
      courseId: course._id,
      title: 'Lesson',
      description: 'Desc',
      youtubeVideoId: 'M7lc1UVf-VE',
      durationSec: 100,
      order: 10,
    });
    return { course, lesson };
  }

  it('creating a Quiz without scope is rejected by validation, including via insertMany', async () => {
    const { course, lesson } = await createCourseAndLesson();
    const questions = [
      {
        text: 'Pick one',
        options: ['A', 'B', 'C', 'D'],
        correctIndex: 1,
        order: 1,
      },
    ];

    await expect(
      Quiz.create({
        courseId: course._id,
        lessonId: lesson._id,
        title: 'Missing scope create',
        questions,
      } as never),
    ).rejects.toThrow(/scope/i);

    await expect(
      Quiz.insertMany([
        {
          courseId: course._id,
          lessonId: lesson._id,
          title: 'Missing scope insertMany',
          questions,
        },
      ] as never),
    ).rejects.toThrow(/scope/i);

    await expect(
      Quiz.insertMany([
        {
          scope: 'lesson',
          lessonId: lesson._id,
          title: 'Missing courseId insertMany',
          questions,
        },
      ] as never),
    ).rejects.toThrow(/courseId/i);
  });

  it('assertQuizDocumentsIntegrity fails loudly on rows missing scope or courseId', async () => {
    const { lesson } = await createCourseAndLesson();

    await Quiz.collection.insertOne({
      lessonId: lesson._id,
      title: 'Legacy corrupt quiz',
      pointsPerQuestion: 1,
      passingScorePct: 70,
      questions: [
        {
          text: 'Q1',
          options: ['A', 'B'],
          correctIndex: 0,
          order: 1,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(assertQuizDocumentsIntegrity()).rejects.toThrow(
      /missing scope and\/or courseId/i,
    );
  });

  it('admin and learner quiz lookups return consistent results for the same lesson', async () => {
    const { course, lesson } = await createCourseAndLesson();
    const learner = await User.create({
      name: 'Learner',
      email: `learner-${Date.now()}@test.local`,
      passwordHash: 'hash',
      role: 'user',
      mustChangePassword: false,
    });

    // Corrupt row (no scope) — both sides must treat as "no quiz".
    await Quiz.collection.insertOne({
      lessonId: lesson._id,
      title: 'Invisible without scope',
      pointsPerQuestion: 1,
      passingScorePct: 70,
      questions: [
        {
          text: 'Q1',
          options: ['A', 'B'],
          correctIndex: 0,
          order: 1,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const existsCorrupt = await Quiz.exists(lessonQuizFilter(lesson._id));
    const detailCorrupt = await getLessonLearningDetail({
      lessonId: lesson._id.toString(),
      userId: learner._id.toString(),
    });
    expect(existsCorrupt).toBeNull();
    expect(detailCorrupt.quiz).toBeNull();
    expect(detailCorrupt.courseNav.lessons[0]?.hasQuiz).toBe(false);

    await Quiz.collection.deleteMany({ lessonId: lesson._id });

    await Quiz.create({
      scope: 'lesson',
      courseId: course._id,
      lessonId: lesson._id,
      title: 'Visible quiz',
      pointsPerQuestion: 1,
      passingScorePct: 70,
      maxAttempts: null,
      questions: [
        {
          text: 'Q1',
          options: ['A', 'B', 'C', 'D'],
          correctIndex: 2,
          order: 1,
        },
      ],
    });

    const existsValid = await Quiz.exists(lessonQuizFilter(lesson._id));
    const adminQuiz = await getLessonQuizForAdmin(lesson._id.toString());
    const detailValid = await getLessonLearningDetail({
      lessonId: lesson._id.toString(),
      userId: learner._id.toString(),
    });

    expect(existsValid).toBeTruthy();
    expect(adminQuiz.title).toBe('Visible quiz');
    expect(detailValid.quiz).toEqual({
      exists: true,
      title: 'Visible quiz',
      questionCount: 1,
      maxPoints: 1,
    });
    expect(detailValid.courseNav.lessons[0]?.hasQuiz).toBe(true);
  });

  it('the seed produces quizzes the learner endpoint can find, plus a valid final exam', async () => {
    process.env.SEED_ADMIN_EMAIL = 'admin@rva.co';
    process.env.SEED_ADMIN_PASSWORD = 'Rva_54321_seed_test_password';

    const seeded = await seedDatabase();
    expect(seeded.lessonCount).toBe(3);
    expect(seeded.finalExamTotal).toBe(50);

    const finalExam = await Quiz.findById(seeded.finalExamId).lean();
    expect(finalExam?.scope).toBe('final_exam');
    expect(finalExam?.courseId).toBeTruthy();
    expect(finalExam?.instructions).toBeTruthy();
    expect(finalExam?.questions).toHaveLength(3);
    expect(finalExam?.questions[0]?.options).toEqual([]);
    expect(finalExam?.questions[0]).not.toHaveProperty('correctIndex');
    expect(finalExam?.maxAttempts).toBeNull();

    const lessonQuizzes = await Quiz.find({ scope: 'lesson' }).lean();
    expect(lessonQuizzes).toHaveLength(2);
    for (const quiz of lessonQuizzes) {
      expect(quiz.scope).toBe('lesson');
      expect(quiz.courseId).toBeTruthy();
      expect(quiz.maxAttempts).toBeNull();
    }

    await assertQuizDocumentsIntegrity();

    await User.updateOne(
      { email: seeded.testUserEmail },
      { $set: { mustChangePassword: false } },
    );

    const passwordHash = await argon2.hash('ChangeMeNow!', {
      type: argon2.argon2id,
    });
    await User.updateOne(
      { email: seeded.testUserEmail },
      { $set: { passwordHash } },
    );

    const login = await request(app).post('/api/auth/login').send({
      email: seeded.testUserEmail,
      password: 'ChangeMeNow!',
    });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;
    const learner = await User.findOne({ email: seeded.testUserEmail }).lean();
    expect(learner).toBeTruthy();

    const quizLessonId = seeded.lessonQuizLessonIds[0]!;
    const lesson = await Lesson.findById(quizLessonId).lean();
    expect(lesson).toBeTruthy();

    await Progress.create({
      userId: learner!._id,
      courseId: seeded.courseId,
      lessons: [
        {
          lessonId: lesson!._id,
          watchedSec: lesson!.requiredWatchSec,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const lessonDetail = await request(app)
      .get(`/api/lessons/${quizLessonId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(lessonDetail.status).toBe(200);
    expect(lessonDetail.body.quiz).toMatchObject({
      exists: true,
      title: expect.any(String),
    });
    expect(lessonDetail.body.lesson).not.toHaveProperty('quizUnlocked');

    const learnerQuiz = await request(app)
      .get(`/api/lessons/${quizLessonId}/quiz`)
      .set('Authorization', `Bearer ${token}`);
    expect(learnerQuiz.status).toBe(200);
    expect(learnerQuiz.body.quiz?.title).toBe(lessonDetail.body.quiz.title);
    expect(learnerQuiz.body.quiz?.questions?.length).toBeGreaterThan(0);

    const quizless = await request(app)
      .get(`/api/lessons/${seeded.quizlessLessonId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(quizless.status).toBe(200);
    expect(quizless.body.quiz).toBeNull();
  });

  it('migrateQuizFinalExams drops stale lessonId unique index and normalizes old exams', async () => {
    const { course, lesson: _lesson } = await createCourseAndLesson();
    void _lesson;

    try {
      await Quiz.collection.dropIndex('lessonId_1');
    } catch {
      // may not exist yet
    }
    await Quiz.collection.createIndex({ lessonId: 1 }, { unique: true, name: 'lessonId_1' });

    await Quiz.collection.insertOne({
      scope: 'final_exam',
      courseId: course._id,
      lessonId: null,
      title: 'Old MCQ final',
      maxAttempts: 3,
      pointsPerQuestion: 3,
      passingScorePct: 70,
      questions: [
        {
          _id: new mongoose.Types.ObjectId(),
          text: 'Pick one',
          options: ['A', 'B', 'C', 'D'],
          correctIndex: 1,
          order: 10,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const summary = await migrateQuizFinalExams();
    expect(summary.droppedIndexes).toContain('lessonId_1');

    const indexes = await Quiz.collection.indexes();
    expect(indexes.some((idx) => idx.name === 'lessonId_1')).toBe(false);
    expect(indexes.some((idx) => idx.name === 'final_exam_unique')).toBe(true);

    const exam = await Quiz.findOne(finalExamFilter(course._id)).lean();
    expect(exam).toBeTruthy();
    expect(exam?.maxAttempts).toBeNull();
    expect(exam?.instructions).toBe('');
    expect(exam?.passingScorePct).toBe(RULES.FINAL_EXAM_PASS_PCT);
    expect(exam?.questions[0]?.options).toEqual([]);
    expect(exam?.questions[0]).not.toHaveProperty('correctIndex');

    const other = await Course.create({
      title: 'Second course',
      slug: `second-${course._id.toString()}`,
      description: 'Needs its own exam',
      category: 'Test',
      level: 'beginner',
      status: 'published',
      createdBy: course.createdBy,
    });
    await Quiz.create({
      scope: 'final_exam',
      courseId: other._id,
      lessonId: null,
      title: 'Second exam',
      instructions: '',
      pointsPerQuestion: RULES.DEFAULT_POINTS_PER_QUESTION,
      passingScorePct: RULES.FINAL_EXAM_PASS_PCT,
      maxAttempts: null,
      questions: [{ text: 'Explain X', options: [], order: 10 }],
    });

    expect(await Quiz.countDocuments({ scope: 'final_exam' })).toBe(2);
  });

  it('assertNoStaleQuizIndexes fails loudly when lessonId_1 exists', async () => {
    try {
      await Quiz.collection.dropIndex('lessonId_1');
    } catch {
      // may not exist yet
    }
    await Quiz.collection.createIndex({ lessonId: 1 }, { unique: true, name: 'lessonId_1' });

    await expect(assertNoStaleQuizIndexes()).rejects.toThrow(/lessonId_1/);

    await Quiz.collection.dropIndex('lessonId_1');
    await Quiz.syncIndexes();
    await expect(assertNoStaleQuizIndexes()).resolves.toBeUndefined();
  });
});

