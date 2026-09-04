import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Quiz } from '../../models/Quiz.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { User } from '../../models/User.js';

describe('Phase 10 progress summary', () => {
  let mongod: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Quiz.syncIndexes();
    await ExamSubmission.syncIndexes();
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
      Progress.deleteMany({}),
      Quiz.deleteMany({}),
      QuizAttempt.deleteMany({}),
      ExamSubmission.deleteMany({}),
    ]);
  });

  async function loginAs(role: 'super_admin' | 'user', email: string) {
    const password = 'test-password-12';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({
      name: role === 'super_admin' ? 'Admin User' : 'Learner One',
      email,
      passwordHash,
      role,
      mustChangePassword: false,
      totalPoints: 0,
    });
    const login = await request(app).post('/api/auth/login').send({ email, password });
    return {
      token: login.body.accessToken as string,
      userId: user._id.toString(),
      user,
    };
  }

  async function seedPublishedCourse(params: {
    adminId: string;
    title: string;
    slug: string;
    lessonCount?: number;
    status?: 'draft' | 'published' | 'archived';
  }) {
    const lessonCount = params.lessonCount ?? 2;
    const course = await Course.create({
      title: params.title,
      slug: params.slug,
      description: 'Desc',
      category: 'Foundations',
      level: 'beginner',
      status: params.status ?? 'published',
      lessonCount,
      totalDurationSec: lessonCount * 60,
      createdBy: params.adminId,
      thumbnailUrl: 'https://example.com/thumb.jpg',
    });

    const lessons = [];
    for (let i = 0; i < lessonCount; i += 1) {
      lessons.push(
        await Lesson.create({
          courseId: course._id,
          title: `${params.title} Lesson ${i + 1}`,
          description: 'L',
          youtubeVideoId: 'dQw4w9WgXcQ',
          durationSec: 60,
          order: (i + 1) * 10,
        }),
      );
    }

    return { course, lessons };
  }

  it('a brand new user with no progress gets every course listed with zeros and an empty inProgress array', async () => {
    const admin = await loginAs('super_admin', 'admin-new@rva.test');
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Alpha',
      slug: 'alpha',
    });
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Beta',
      slug: 'beta',
    });

    const learner = await loginAs('user', 'new-learner@rva.test');
    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.inProgress).toEqual([]);
    expect(res.body.continueLearning).toBeUndefined();
    expect(res.body.courses).toHaveLength(2);
    expect(res.body.coursesStarted).toBe(0);
    expect(res.body.coursesCompleted).toBe(0);
    expect(res.body.lessonsCompleted).toBe(0);
    for (const course of res.body.courses) {
      expect(course.completedLessonCount).toBe(0);
      expect(course.progressPct).toBe(0);
      expect(course.totalPointsEarned).toBe(0);
      expect(course.finalExamUnlocked).toBe(false);
      expect(course.thumbnailUrl).toBe('https://example.com/thumb.jpg');
      expect(course).not.toHaveProperty('thumbnailPublicId');
    }
    expect(JSON.stringify(res.body)).not.toMatch(/thumbnailPublicId/);
  });

  it('draft and archived courses never appear', async () => {
    const admin = await loginAs('super_admin', 'admin-vis@rva.test');
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Visible',
      slug: 'visible',
    });
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Drafty',
      slug: 'drafty',
      status: 'draft',
    });
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Old',
      slug: 'old',
      status: 'archived',
    });

    const learner = await loginAs('user', 'vis-learner@rva.test');
    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.body.courses).toHaveLength(1);
    expect(res.body.courses[0].title).toBe('Visible');
  });

  it('progressPct is correct after some lessons are complete', async () => {
    const admin = await loginAs('super_admin', 'admin-pct@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Pct Course',
      slug: 'pct-course',
      lessonCount: 2,
    });
    const learner = await loginAs('user', 'pct-learner@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      lastLessonId: lessons[0]!._id,
      startedAt: new Date(),
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.body.courses[0].completedLessonCount).toBe(1);
    expect(res.body.courses[0].progressPct).toBe(50);
    expect(res.body.lessonsCompleted).toBe(1);
    expect(res.body.inProgress).toHaveLength(1);
    expect(res.body.inProgress[0]).toMatchObject({
      courseId: course._id.toString(),
      courseTitle: 'Pct Course',
      lessonId: lessons[0]!._id.toString(),
      lessonTitle: lessons[0]!.title,
      completedLessonCount: 1,
      lessonCount: 2,
    });
    expect(res.body.continueLearning).toBeUndefined();
  });

  it('a failed quiz does NOT reduce or block lesson completion', async () => {
    const admin = await loginAs('super_admin', 'admin-fail@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Fail Quiz',
      slug: 'fail-quiz',
      lessonCount: 1,
    });
    const learner = await loginAs('user', 'fail-learner@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      lastLessonId: lessons[0]!._id,
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 10,
          quizPointsAwarded: 0,
          attempts: 2,
        },
      ],
    });

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.body.courses[0].completedLessonCount).toBe(1);
    expect(res.body.courses[0].progressPct).toBe(100);
    expect(res.body.coursesCompleted).toBe(1);
  });

  it('finalExamUnlocked flips true only when every lesson video is complete', async () => {
    const admin = await loginAs('super_admin', 'admin-exam@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Exam Course',
      slug: 'exam-course',
      lessonCount: 2,
    });
    await Quiz.create({
      scope: 'final_exam',
      courseId: course._id,
      lessonId: null,
      title: 'Final',
      pointsPerQuestion: 10,
      passingScorePct: 70,
      maxAttempts: 3,
      questions: [
        {
          text: 'Q1',
          options: ['A', 'B'],
          correctIndex: 0,
          order: 10,
        },
        {
          text: 'Q2',
          options: ['A', 'B'],
          correctIndex: 1,
          order: 20,
        },
      ],
    });

    const learner = await loginAs('user', 'exam-learner@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const locked = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(locked.body.courses[0].finalExamUnlocked).toBe(false);

    await Progress.updateOne(
      { userId: learner.userId, courseId: course._id },
      {
        $push: {
          lessons: {
            lessonId: lessons[1]!._id,
            watchedSec: 60,
            videoCompletedAt: new Date(),
            videoPointsAwarded: true,
            bestQuizScore: 0,
            quizPointsAwarded: 0,
            attempts: 0,
          },
        },
      },
    );

    const unlocked = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(unlocked.body.courses[0].finalExamUnlocked).toBe(true);
    expect(unlocked.body.courses[0].finalExamCompleted).toBe(false);
  });

  it('a course with zero lessons does not divide by zero', async () => {
    const admin = await loginAs('super_admin', 'admin-zero@rva.test');
    await Course.create({
      title: 'Empty',
      slug: 'empty-course',
      description: 'No lessons',
      category: 'Foundations',
      level: 'beginner',
      status: 'published',
      lessonCount: 0,
      totalDurationSec: 0,
      createdBy: admin.userId,
    });

    const learner = await loginAs('user', 'zero-learner@rva.test');
    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.courses[0].progressPct).toBe(0);
    expect(res.body.courses[0].finalExamUnlocked).toBe(false);
  });

  it("passing another user's id anywhere returns only the caller's own data", async () => {
    const admin = await loginAs('super_admin', 'admin-idor@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'IDOR Course',
      slug: 'idor-course',
    });

    const victim = await loginAs('user', 'victim@rva.test');
    const attacker = await loginAs('user', 'attacker@rva.test');

    await Progress.create({
      userId: victim.userId,
      courseId: course._id,
      lastLessonId: lessons[0]!._id,
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 100,
          quizPointsAwarded: 10,
          attempts: 1,
        },
      ],
    });
    await User.findByIdAndUpdate(victim.userId, { totalPoints: 15 });

    const res = await request(app)
      .get(`/api/progress/summary?userId=${victim.userId}`)
      .set('Authorization', `Bearer ${attacker.token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPoints).toBe(0);
    expect(res.body.courses[0].completedLessonCount).toBe(0);
    expect(res.body.inProgress).toEqual([]);
  });

  it('a learner with three started courses gets all three inProgress, most recently active first', async () => {
    const admin = await loginAs('super_admin', 'admin-ip3@rva.test');
    const learner = await loginAs('user', 'ip3-learner@rva.test');

    const seeded = [];
    for (const title of ['Course A', 'Course B', 'Course C']) {
      seeded.push(
        await seedPublishedCourse({
          adminId: admin.userId,
          title,
          slug: title.toLowerCase().replace(/\s+/g, '-'),
          lessonCount: 2,
        }),
      );
    }

    const times = [
      new Date('2026-01-01T10:00:00.000Z'),
      new Date('2026-01-03T10:00:00.000Z'),
      new Date('2026-01-02T10:00:00.000Z'),
    ];

    for (let i = 0; i < seeded.length; i += 1) {
      const { course, lessons } = seeded[i]!;
      await Progress.create({
        userId: learner.userId,
        courseId: course._id,
        lastLessonId: lessons[0]!._id,
        startedAt: times[i],
        updatedAt: times[i],
        lessons: [
          {
            lessonId: lessons[0]!._id,
            watchedSec: 20,
            videoPointsAwarded: false,
            bestQuizScore: 0,
            quizPointsAwarded: 0,
            attempts: 0,
          },
        ],
      });
      await Progress.collection.updateOne(
        { userId: new mongoose.Types.ObjectId(learner.userId), courseId: course._id },
        { $set: { updatedAt: times[i] } },
      );
    }

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.inProgress).toHaveLength(3);
    expect(res.body.inProgress.map((row: { courseTitle: string }) => row.courseTitle)).toEqual([
      'Course B',
      'Course C',
      'Course A',
    ]);
    for (const row of res.body.inProgress) {
      expect(row).toMatchObject({
        completedLessonCount: 0,
        lessonCount: 2,
      });
      expect(row.lessonId).toBeTruthy();
      expect(row.lastActivityAt).toBeTruthy();
      expect(row.thumbnailUrl).toBe('https://example.com/thumb.jpg');
    }
  });

  it('a course with a thumbnail returns thumbnailUrl on summary, catalog, and detail', async () => {
    const admin = await loginAs('super_admin', 'admin-thumb-payloads@rva.test');
    const { course } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Thumb Payloads',
      slug: 'thumb-payloads',
    });
    await Course.findByIdAndUpdate(course._id, {
      thumbnailPublicId: 'rva/thumbnails/internal-only',
    });

    const learner = await loginAs('user', 'thumb-payloads-learner@rva.test');
    const headers = { Authorization: `Bearer ${learner.token}` };
    const thumb = 'https://example.com/thumb.jpg';
    const courseId = course._id.toString();

    const summary = await request(app).get('/api/progress/summary').set(headers);
    expect(summary.status).toBe(200);
    expect(summary.body.courses).toHaveLength(1);
    expect(summary.body.courses[0].thumbnailUrl).toBe(thumb);
    expect(summary.body.courses[0]).not.toHaveProperty('thumbnailPublicId');
    expect(JSON.stringify(summary.body)).not.toMatch(/thumbnailPublicId/);

    const catalog = await request(app).get('/api/courses').set(headers);
    expect(catalog.status).toBe(200);
    const catalogRow = catalog.body.data.find((row: { id: string }) => row.id === courseId);
    expect(catalogRow.thumbnailUrl).toBe(thumb);
    expect(catalogRow).not.toHaveProperty('thumbnailPublicId');
    expect(JSON.stringify(catalog.body)).not.toMatch(/thumbnailPublicId/);

    const detail = await request(app).get(`/api/courses/${courseId}`).set(headers);
    expect(detail.status).toBe(200);
    expect(detail.body.course.thumbnailUrl).toBe(thumb);
    expect(detail.body.course).not.toHaveProperty('thumbnailPublicId');
    expect(JSON.stringify(detail.body)).not.toMatch(/thumbnailPublicId/);
  });

  it('a learner with four started courses gets exactly three inProgress', async () => {
    const admin = await loginAs('super_admin', 'admin-ip4@rva.test');
    const learner = await loginAs('user', 'ip4-learner@rva.test');

    for (let i = 0; i < 4; i += 1) {
      const { course, lessons } = await seedPublishedCourse({
        adminId: admin.userId,
        title: `Four ${i}`,
        slug: `four-${i}`,
        lessonCount: 2,
      });
      const activityAt = new Date(`2026-02-0${i + 1}T12:00:00.000Z`);
      await Progress.create({
        userId: learner.userId,
        courseId: course._id,
        lastLessonId: lessons[0]!._id,
        lessons: [
          {
            lessonId: lessons[0]!._id,
            watchedSec: 15,
            videoPointsAwarded: false,
            bestQuizScore: 0,
            quizPointsAwarded: 0,
            attempts: 0,
          },
        ],
      });
      await Progress.collection.updateOne(
        { userId: new mongoose.Types.ObjectId(learner.userId), courseId: course._id },
        { $set: { updatedAt: activityAt } },
      );
    }

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.body.inProgress).toHaveLength(3);
    expect(res.body.inProgress.map((row: { courseTitle: string }) => row.courseTitle)).toEqual([
      'Four 3',
      'Four 2',
      'Four 1',
    ]);
  });

  it('a course that is merely visible but never started is excluded from inProgress', async () => {
    const admin = await loginAs('super_admin', 'admin-ip-vis@rva.test');
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Visible Only',
      slug: 'visible-only',
    });
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Started',
      slug: 'started-one',
      lessonCount: 2,
    });
    const learner = await loginAs('user', 'ip-vis-learner@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      lastLessonId: lessons[0]!._id,
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 10,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.body.courses).toHaveLength(2);
    expect(res.body.inProgress).toHaveLength(1);
    expect(res.body.inProgress[0].courseTitle).toBe('Started');
  });

  it('a completed course is excluded from inProgress', async () => {
    const admin = await loginAs('super_admin', 'admin-ip-done@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Done Course',
      slug: 'done-course',
      lessonCount: 1,
    });
    const { course: openCourse, lessons: openLessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Open Course',
      slug: 'open-course',
      lessonCount: 2,
    });
    const learner = await loginAs('user', 'ip-done-learner@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      lastLessonId: lessons[0]!._id,
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    await Progress.create({
      userId: learner.userId,
      courseId: openCourse._id,
      lastLessonId: openLessons[0]!._id,
      lessons: [
        {
          lessonId: openLessons[0]!._id,
          watchedSec: 12,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.body.coursesCompleted).toBe(1);
    expect(res.body.inProgress).toHaveLength(1);
    expect(res.body.inProgress[0].courseTitle).toBe('Open Course');
  });

  it('a learner with nothing started gets an empty inProgress array, not null', async () => {
    const admin = await loginAs('super_admin', 'admin-ip-empty@rva.test');
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Idle',
      slug: 'idle-course',
    });
    const learner = await loginAs('user', 'ip-empty-learner@rva.test');

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.body.inProgress).toEqual([]);
    expect(res.body.inProgress).not.toBeNull();
  });

  it('the endpoint issues a bounded number of queries regardless of course count', async () => {
    const admin = await loginAs('super_admin', 'admin-bound@rva.test');
    for (let i = 0; i < 8; i += 1) {
      await seedPublishedCourse({
        adminId: admin.userId,
        title: `Bound ${i}`,
        slug: `bound-${i}`,
      });
    }

    const learner = await loginAs('user', 'bound-learner@rva.test');
    const aggregateSpy = vi.spyOn(User, 'aggregate');

    const res = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.courses).toHaveLength(8);
    // Authenticate loads the user once; summary uses a single aggregate.
    expect(aggregateSpy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(aggregateSpy).toHaveBeenCalled();
    aggregateSpy.mockRestore();
  });
});

describe('Phase 15 progress detail + admin', () => {
  let mongod: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Quiz.syncIndexes();
    await ExamSubmission.syncIndexes();
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
      Progress.deleteMany({}),
      Quiz.deleteMany({}),
      QuizAttempt.deleteMany({}),
      ExamSubmission.deleteMany({}),
    ]);
  });

  async function loginAs(role: 'super_admin' | 'user', email: string, extras?: { isActive?: boolean }) {
    const password = 'test-password-12';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({
      name: role === 'super_admin' ? 'Admin User' : email.split('@')[0]!,
      email,
      passwordHash,
      role,
      mustChangePassword: false,
      totalPoints: 0,
      isActive: extras?.isActive ?? true,
    });
    const login = await request(app).post('/api/auth/login').send({ email, password });
    return {
      token: login.body.accessToken as string,
      userId: user._id.toString(),
      user,
    };
  }

  async function seedPublishedCourse(params: {
    adminId: string;
    title: string;
    slug: string;
    lessonCount?: number;
  }) {
    const lessonCount = params.lessonCount ?? 2;
    const course = await Course.create({
      title: params.title,
      slug: params.slug,
      description: 'Desc',
      category: 'Foundations',
      level: 'beginner',
      status: 'published',
      lessonCount,
      totalDurationSec: lessonCount * 60,
      createdBy: params.adminId,
      thumbnailUrl: 'https://example.com/thumb.jpg',
    });

    const lessons = [];
    for (let i = 0; i < lessonCount; i += 1) {
      lessons.push(
        await Lesson.create({
          courseId: course._id,
          title: `${params.title} Lesson ${i + 1}`,
          description: 'L',
          youtubeVideoId: 'dQw4w9WgXcQ',
          durationSec: 60,
          order: (i + 1) * 10,
        }),
      );
    }

    return { course, lessons };
  }

  it("a user passing ?userId= for another user still receives only their own data", async () => {
    const admin = await loginAs('super_admin', 'admin-idor2@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'IDOR Detail',
      slug: 'idor-detail',
      lessonCount: 1,
    });

    const victim = await loginAs('user', 'victim2@rva.test');
    const attacker = await loginAs('user', 'attacker2@rva.test');

    await Progress.create({
      userId: victim.userId,
      courseId: course._id,
      startedAt: new Date(),
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    await User.findByIdAndUpdate(victim.userId, { totalPoints: 5 });

    const res = await request(app)
      .get(`/api/progress?userId=${victim.userId}`)
      .set('Authorization', `Bearer ${attacker.token}`);

    expect(res.status).toBe(200);
    expect(res.body.totals.totalPoints).toBe(0);
    expect(res.body.totals.lessonsCompleted).toBe(0);
    expect(res.body.courses[0].completedLessonCount).toBe(0);
  });

  it('a user gets FORBIDDEN on both /api/admin/progress routes', async () => {
    const admin = await loginAs('super_admin', 'admin-forbid@rva.test');
    const learner = await loginAs('user', 'forbid-learner@rva.test');

    const list = await request(app)
      .get('/api/admin/progress')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');

    const detail = await request(app)
      .get(`/api/admin/progress/${admin.userId}`)
      .set('Authorization', `Bearer ${learner.token}`);
    expect(detail.status).toBe(403);
    expect(detail.body.error.code).toBe('FORBIDDEN');
  });

  it('pointsAvailable is correct with and without a final exam, and with quizless lessons', async () => {
    const admin = await loginAs('super_admin', 'admin-pts@rva.test');
    const { course: noExam, lessons: noExamLessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'No Exam',
      slug: 'no-exam',
      lessonCount: 2,
    });
    await Quiz.create({
      scope: 'lesson',
      courseId: noExam._id,
      lessonId: noExamLessons[0]!._id,
      title: 'L1 Quiz',
      pointsPerQuestion: 2,
      passingScorePct: 70,
      questions: [
        { text: 'Q1', options: ['A', 'B'], correctIndex: 0, order: 10 },
        { text: 'Q2', options: ['A', 'B'], correctIndex: 1, order: 20 },
      ],
    });
    // Lesson 2 has no quiz.

    const { course: withExam, lessons: examLessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'With Exam',
      slug: 'with-exam',
      lessonCount: 1,
    });
    await Quiz.create({
      scope: 'final_exam',
      courseId: withExam._id,
      lessonId: null,
      title: 'Final',
      instructions: 'Write your answers.',
      maxAttempts: null,
      questions: [{ text: 'Q1', options: [], order: 10 }],
    });

    const learner = await loginAs('user', 'pts-learner@rva.test');
    const res = await request(app)
      .get('/api/progress')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.status).toBe(200);
    const noExamCourse = res.body.courses.find(
      (c: { title: string }) => c.title === 'No Exam',
    );
    const withExamCourse = res.body.courses.find(
      (c: { title: string }) => c.title === 'With Exam',
    );

    // 2 lessons × 5 + quiz max (2×2=4) + no exam = 14
    expect(noExamCourse.pointsAvailable).toBe(14);
    expect(noExamCourse.lessons[0].quizMaxScore).toBe(4);
    expect(noExamCourse.lessons[1].quizMaxScore).toBeNull();
    expect(noExamCourse.finalExam).toBeNull();

    // 1 lesson × 5 + no lesson quiz + exam max 50 = 55
    expect(withExamCourse.pointsAvailable).toBe(55);
    expect(withExamCourse.finalExam).toMatchObject({
      exists: true,
      unlocked: false,
      maxMarks: 50,
      passMark: 40,
      submissionStatus: null,
      marksAwarded: null,
      passed: null,
    });
    expect(examLessons).toHaveLength(1);
  });

  it('totals equal the sum of the per-course figures', async () => {
    const admin = await loginAs('super_admin', 'admin-sum@rva.test');
    const a = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Sum A',
      slug: 'sum-a',
      lessonCount: 1,
    });
    const b = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Sum B',
      slug: 'sum-b',
      lessonCount: 1,
    });
    const learner = await loginAs('user', 'sum-learner@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: a.course._id,
      startedAt: new Date(),
      lessons: [
        {
          lessonId: a.lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    await Progress.create({
      userId: learner.userId,
      courseId: b.course._id,
      startedAt: new Date(),
      lessons: [
        {
          lessonId: b.lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 4,
          quizPointsAwarded: 4,
          attempts: 1,
        },
      ],
    });

    const res = await request(app)
      .get('/api/progress')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.status).toBe(200);
    const sumEarned = res.body.courses.reduce(
      (acc: number, c: { pointsEarned: number }) => acc + c.pointsEarned,
      0,
    );
    const sumLessons = res.body.courses.reduce(
      (acc: number, c: { completedLessonCount: number }) => acc + c.completedLessonCount,
      0,
    );
    expect(res.body.totals.totalPoints).toBe(sumEarned);
    expect(res.body.totals.lessonsCompleted).toBe(sumLessons);
    expect(res.body.totals.videoPoints + res.body.totals.quizPoints + res.body.totals.examPoints).toBe(
      res.body.totals.totalPoints,
    );
  });

  it('a user with no activity at all returns a valid empty-state payload, not an error', async () => {
    const admin = await loginAs('super_admin', 'admin-empty@rva.test');
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Empty State',
      slug: 'empty-state',
    });
    const learner = await loginAs('user', 'empty-learner@rva.test');

    const res = await request(app)
      .get('/api/progress')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      totalPoints: 0,
      videoPoints: 0,
      quizPoints: 0,
      examPoints: 0,
      lessonsCompleted: 0,
      coursesCompleted: 0,
      quizzesTaken: 0,
      examsTaken: 0,
    });
    expect(res.body.courses).toHaveLength(1);
    expect(res.body.courses[0].pointsEarned).toBe(0);
    expect(res.body.courses[0].startedAt).toBeNull();
    expect(res.body.courses[0].completedAt).toBeNull();
  });

  it('the admin list paginates correctly and includes deactivated users', async () => {
    const admin = await loginAs('super_admin', 'admin-list@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'List Course',
      slug: 'list-course',
      lessonCount: 1,
    });

    const active = await loginAs('user', 'active-list@rva.test');
    const inactivePassword = 'test-password-12';
    const inactiveHash = await argon2.hash(inactivePassword, { type: argon2.argon2id });
    const inactive = await User.create({
      name: 'inactive-list',
      email: 'inactive-list@rva.test',
      passwordHash: inactiveHash,
      role: 'user',
      mustChangePassword: false,
      totalPoints: 2,
      isActive: false,
    });
    await loginAs('user', 'idle-list@rva.test');

    await Progress.create({
      userId: active.userId,
      courseId: course._id,
      startedAt: new Date(),
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    await User.findByIdAndUpdate(active.userId, { totalPoints: 5 });

    const page1 = await request(app)
      .get('/api/admin/progress?page=1&limit=2&sort=-totalPoints')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(page1.status).toBe(200);
    expect(page1.body.meta).toMatchObject({ page: 1, limit: 2, total: 3 });
    expect(page1.body.data).toHaveLength(2);
    const emails = page1.body.data.map((r: { email: string }) => r.email);
    const allEmails = [
      ...emails,
      ...(
        await request(app)
          .get('/api/admin/progress?page=2&limit=2&sort=-totalPoints')
          .set('Authorization', `Bearer ${admin.token}`)
      ).body.data.map((r: { email: string }) => r.email),
    ];
    expect(allEmails).toContain('inactive-list@rva.test');
    expect(inactive._id).toBeTruthy();


    const page2 = await request(app)
      .get('/api/admin/progress?page=2&limit=2&sort=-totalPoints')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(page2.body.data).toHaveLength(1);

    const detail = await request(app)
      .get(`/api/admin/progress/${active.userId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.totals.lessonsCompleted).toBe(1);
    expect(detail.body.totals.totalPoints).toBe(5);
  });

  it('the admin list issues a bounded number of queries regardless of user count', async () => {
    const admin = await loginAs('super_admin', 'admin-bound-list@rva.test');
    await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Bound List',
      slug: 'bound-list',
    });

    for (let i = 0; i < 12; i += 1) {
      await loginAs('user', `bound-u${i}@rva.test`);
    }

    const aggregateSpy = vi.spyOn(User, 'aggregate');
    const findSpy = vi.spyOn(User, 'find');

    const res = await request(app)
      .get('/api/admin/progress?page=1&limit=5')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(12);
    expect(aggregateSpy.mock.calls.length).toBeLessThanOrEqual(2);
    // No per-user find loops for the table payload.
    expect(findSpy.mock.calls.length).toBeLessThanOrEqual(1);
    aggregateSpy.mockRestore();
    findSpy.mockRestore();
  });

  it('a heartbeat without videoCompletedAt counts as 0 completed across admin, summary, and detail', async () => {
    const admin = await loginAs('super_admin', 'admin-hb-only@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Heartbeat Only',
      slug: 'heartbeat-only',
      lessonCount: 1,
    });
    const learner = await loginAs('user', 'hb-only@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      startedAt: new Date(),
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 22,
          // videoCompletedAt intentionally omitted — first heartbeat only
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const adminList = await request(app)
      .get('/api/admin/progress?search=hb-only')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(adminList.status).toBe(200);
    const adminRow = adminList.body.data.find(
      (row: { email: string }) => row.email === 'hb-only@rva.test',
    );
    expect(adminRow).toMatchObject({
      coursesCompleted: 0,
      lessonsCompleted: 0,
      totalPoints: 0,
      coursesStarted: 1,
    });

    const summary = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.coursesCompleted).toBe(0);
    expect(summary.body.lessonsCompleted).toBe(0);
    expect(summary.body.courses[0].completedLessonCount).toBe(0);
    expect(summary.body.courses[0].progressPct).toBe(0);

    const detail = await request(app)
      .get('/api/progress')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.totals.lessonsCompleted).toBe(0);
    expect(detail.body.totals.coursesCompleted).toBe(0);
    expect(detail.body.courses[0].completedLessonCount).toBe(0);
    expect(detail.body.courses[0].lessons[0]).toMatchObject({
      started: true,
      watchedSec: 22,
      videoCompletedAt: null,
      videoPointsAwarded: 0,
    });

    const courseDetail = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${learner.token}`);
    expect(courseDetail.status).toBe(200);
    expect(courseDetail.body.summary.completedLessonCount).toBe(0);
    expect(courseDetail.body.summary.progressPct).toBe(0);

    // The three learner-facing completion numbers never disagree.
    expect(summary.body.lessonsCompleted).toBe(detail.body.totals.lessonsCompleted);
    expect(summary.body.courses[0].completedLessonCount).toBe(
      courseDetail.body.summary.completedLessonCount,
    );
    expect(adminRow.lessonsCompleted).toBe(summary.body.lessonsCompleted);
  });

  it('a completed video shows 1 lesson completed and 5 points across all payloads', async () => {
    const admin = await loginAs('super_admin', 'admin-vid-done@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Video Done',
      slug: 'video-done',
      lessonCount: 1,
    });
    const learner = await loginAs('user', 'vid-done@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      startedAt: new Date(),
      completedAt: new Date(),
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 60,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    await User.findByIdAndUpdate(learner.userId, { totalPoints: 5 });

    const adminList = await request(app)
      .get('/api/admin/progress?search=vid-done')
      .set('Authorization', `Bearer ${admin.token}`);
    const adminRow = adminList.body.data.find(
      (row: { email: string }) => row.email === 'vid-done@rva.test',
    );
    expect(adminRow).toMatchObject({
      coursesCompleted: 1,
      lessonsCompleted: 1,
      totalPoints: 5,
    });

    const summary = await request(app)
      .get('/api/progress/summary')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(summary.body.coursesCompleted).toBe(1);
    expect(summary.body.lessonsCompleted).toBe(1);
    expect(summary.body.courses[0].completedLessonCount).toBe(1);
    expect(summary.body.courses[0].totalPointsEarned).toBe(5);

    const detail = await request(app)
      .get('/api/progress')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(detail.body.totals.lessonsCompleted).toBe(1);
    expect(detail.body.totals.coursesCompleted).toBe(1);
    expect(detail.body.totals.videoPoints).toBe(5);
    expect(detail.body.courses[0].lessons[0].videoCompletedAt).toBeTruthy();
    expect(detail.body.courses[0].lessons[0].videoPointsAwarded).toBe(5);

    const courseDetail = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${learner.token}`);
    expect(courseDetail.body.summary.completedLessonCount).toBe(1);
    expect(courseDetail.body.summary.totalPointsEarned).toBe(5);

    expect(adminRow.lessonsCompleted).toBe(summary.body.lessonsCompleted);
    expect(summary.body.lessonsCompleted).toBe(detail.body.totals.lessonsCompleted);
    expect(detail.body.courses[0].completedLessonCount).toBe(
      courseDetail.body.summary.completedLessonCount,
    );
  });

  it('detail distinguishes not-started lessons from started-but-incomplete', async () => {
    const admin = await loginAs('super_admin', 'admin-ns@rva.test');
    const { course, lessons } = await seedPublishedCourse({
      adminId: admin.userId,
      title: 'Not Started Dist',
      slug: 'not-started-dist',
      lessonCount: 2,
    });
    const learner = await loginAs('user', 'ns-dist@rva.test');

    await Progress.create({
      userId: learner.userId,
      courseId: course._id,
      startedAt: new Date(),
      lessons: [
        {
          lessonId: lessons[0]!._id,
          watchedSec: 10,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const detail = await request(app)
      .get('/api/progress')
      .set('Authorization', `Bearer ${learner.token}`);

    expect(detail.status).toBe(200);
    const [started, untouched] = detail.body.courses[0].lessons;
    expect(started).toMatchObject({
      started: true,
      watchedSec: 10,
      videoCompletedAt: null,
      videoPointsAwarded: 0,
    });
    expect(untouched).toMatchObject({
      started: false,
      watchedSec: 0,
      videoCompletedAt: null,
      videoPointsAwarded: 0,
    });
    expect(detail.body.courses[0].completedLessonCount).toBe(0);
    expect(started.requiredWatchSec).toBeGreaterThan(0);
  });
});
