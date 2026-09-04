import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RULES } from '../../shared/index.js';
import { createApp } from '../../app.js';
import { Badge } from '../../models/Badge.js';
import { Course } from '../../models/Course.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Lesson } from '../../models/Lesson.js';
import { Notification } from '../../models/Notification.js';
import { Progress } from '../../models/Progress.js';
import { Quiz } from '../../models/Quiz.js';
import { User } from '../../models/User.js';

describe('Phase C notifications', () => {
  let mongod: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Notification.syncIndexes();
    await ExamSubmission.syncIndexes();
    await Badge.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      User.deleteMany({}),
      Course.deleteMany({}),
      Lesson.deleteMany({}),
      Quiz.deleteMany({}),
      ExamSubmission.deleteMany({}),
      Badge.deleteMany({}),
      Notification.deleteMany({}),
      Progress.deleteMany({}),
    ]);
  });

  async function loginAs(role: 'super_admin' | 'user', email: string) {
    const password = 'test-password-12';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({
      name: role === 'super_admin' ? 'Admin' : 'Learner',
      email,
      passwordHash,
      role,
      mustChangePassword: false,
    });
    const login = await request(app).post('/api/auth/login').send({ email, password });
    return {
      token: login.body.accessToken as string,
      userId: user._id.toString(),
    };
  }

  async function seedSubmittedExam(learnerEmail: string) {
    const admin = await loginAs('super_admin', `admin-${Date.now()}@rva.test`);
    const learner = await loginAs('user', learnerEmail);

    const courseRes = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        title: 'Notify Course',
        description: 'For notification tests',
        category: 'Foundations',
        level: 'beginner',
      });
    expect(courseRes.status).toBe(201);
    const courseId = courseRes.body.course.id as string;

    const lessonRes = await request(app)
      .post(`/api/courses/${courseId}/lessons`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        title: 'Lesson one',
        description: 'Watch me',
        youtubeVideoId: 'dQw4w9WgXcQ',
        durationSec: 100,
      });
    expect(lessonRes.status).toBe(201);
    const lessonId = lessonRes.body.lesson.id as string;

    await request(app)
      .patch(`/api/courses/${courseId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'published' });

    await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        title: 'Written final',
        instructions: 'Answer offline',
        questions: [{ text: 'Q1' }],
      });

    const course = await Course.findById(courseId);
    const lesson = await Lesson.findById(lessonId);
    await Progress.create({
      userId: learner.userId,
      courseId: course!._id,
      startedAt: new Date(),
      lastLessonId: lesson!._id,
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
    await User.updateOne(
      { _id: learner.userId },
      { $set: { totalPoints: RULES.VIDEO_POINTS } },
    );

    const submit = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${learner.token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/abc' });
    expect(submit.status).toBe(200);

    const submission = await ExamSubmission.findOne({
      userId: learner.userId,
      courseId,
    });

    return {
      admin,
      learner,
      courseId,
      submissionId: submission!._id.toString(),
    };
  }

  it('grading emits exactly one exam_graded notification', async () => {
    const { admin, learner, submissionId } = await seedSubmittedExam('fail-n@rva.test');

    const grade = await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 30 });
    expect(grade.status).toBe(200);

    const rows = await Notification.find({ userId: learner.userId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('exam_graded');
    expect(rows[0]!.body).toMatch(/30\/50/);
    expect(rows[0]!.body).toMatch(/fail/i);
    expect(rows[0]!.link).toMatch(/^\/exam\//);
  });

  it(
    'a passing grade emits both exam_graded and badge_earned; a failing grade emits only the first',
    async () => {
    const passCase = await seedSubmittedExam('pass-n@rva.test');
    const passGrade = await request(app)
      .post(`/api/admin/exam-submissions/${passCase.submissionId}/grade`)
      .set('Authorization', `Bearer ${passCase.admin.token}`)
      .send({ marksAwarded: 40 });
    expect(passGrade.status).toBe(200);

    const passRows = await Notification.find({ userId: passCase.learner.userId })
      .sort({ type: 1 })
      .lean();
    expect(passRows.map((r) => r.type).sort()).toEqual(['badge_earned', 'exam_graded']);
    expect(passRows.find((r) => r.type === 'exam_graded')!.body).toMatch(/pass/i);

    const failCase = await seedSubmittedExam('fail-only-n@rva.test');
    await request(app)
      .post(`/api/admin/exam-submissions/${failCase.submissionId}/grade`)
      .set('Authorization', `Bearer ${failCase.admin.token}`)
      .send({ marksAwarded: 39 });

    const failRows = await Notification.find({ userId: failCase.learner.userId }).lean();
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.type).toBe('exam_graded');
  },
    20_000,
  );

  it("a user cannot read, list, or mark read another user's notifications", async () => {
    const { admin, learner, submissionId } = await seedSubmittedExam('owner-n@rva.test');
    await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 42 });

    const note = await Notification.findOne({ userId: learner.userId });
    expect(note).toBeTruthy();

    const other = await loginAs('user', 'other-n@rva.test');

    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${other.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    const mark = await request(app)
      .patch(`/api/notifications/${note!._id.toString()}/read`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(mark.status).toBe(404);
    expect(mark.body.error.code).toBe('NOT_FOUND');
  });

  it('the unread count is correct and drops to zero after read-all', async () => {
    const { admin, learner, submissionId } = await seedSubmittedExam('count-n@rva.test');
    await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 45 });

    const countBefore = await request(app)
      .get('/api/notifications/count')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(countBefore.status).toBe(200);
    expect(countBefore.body.unread).toBe(2);

    const readAll = await request(app)
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(readAll.status).toBe(200);
    expect(readAll.body.updated).toBe(2);

    const countAfter = await request(app)
      .get('/api/notifications/count')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(countAfter.body.unread).toBe(0);
  });

  it('a notification creation failure does not roll back or fail the grading operation', async () => {
    const { admin, learner, submissionId } = await seedSubmittedExam('safe-n@rva.test');

    vi.spyOn(Notification, 'create').mockRejectedValue(new Error('notifications down'));

    const grade = await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 40 });
    expect(grade.status).toBe(200);
    expect(grade.body.pointsAwarded).toBe(40);
    expect(grade.body.submission.passed).toBe(true);

    const user = await User.findById(learner.userId);
    expect(user!.totalPoints).toBe(RULES.VIDEO_POINTS + 40);
    expect(await Badge.countDocuments({ userId: learner.userId })).toBe(1);
  });

  it('marking an already-read notification is a harmless no-op', async () => {
    const { admin, learner, submissionId } = await seedSubmittedExam('noop-n@rva.test');
    await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 20 });

    const note = await Notification.findOne({ userId: learner.userId });
    const first = await request(app)
      .patch(`/api/notifications/${note!._id.toString()}/read`)
      .set('Authorization', `Bearer ${learner.token}`);
    expect(first.status).toBe(200);
    expect(first.body.notification.readAt).toBeTruthy();
    const readAt = first.body.notification.readAt as string;

    const second = await request(app)
      .patch(`/api/notifications/${note!._id.toString()}/read`)
      .set('Authorization', `Bearer ${learner.token}`);
    expect(second.status).toBe(200);
    expect(second.body.notification.readAt).toBe(readAt);
  });
});
