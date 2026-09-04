import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../../shared/index.js';
import { createApp } from '../../app.js';
import { Badge } from '../../models/Badge.js';
import { Course } from '../../models/Course.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { Quiz } from '../../models/Quiz.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { User } from '../../models/User.js';

describe('Phase B grading + badges', () => {
  let mongod: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await ExamSubmission.syncIndexes();
    await Badge.syncIndexes();
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
      QuizAttempt.deleteMany({}),
      ExamSubmission.deleteMany({}),
      Badge.deleteMany({}),
      Progress.deleteMany({}),
    ]);
  });

  async function loginAs(role: 'super_admin' | 'user', email: string, name?: string) {
    const password = 'test-password-12';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({
      name: name ?? (role === 'super_admin' ? 'Admin' : 'Learner'),
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

  async function seedSubmittedExam(opts?: {
    learnerEmail?: string;
    videoComplete?: boolean;
  }) {
    const admin = await loginAs('super_admin', `admin-${Date.now()}@rva.test`);
    const learner = await loginAs(
      'user',
      opts?.learnerEmail ?? `learner-${Date.now()}@rva.test`,
      'Ada Learner',
    );

    const courseRes = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        title: 'Grading Course',
        description: 'For grading tests',
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
        questions: [{ text: 'Q1' }, { text: 'Q2' }],
      });

    if (opts?.videoComplete !== false) {
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
    }

    const submit = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${learner.token}`)
      .send({
        docUrl: 'https://docs.google.com/document/d/abc',
        loomUrl: 'https://www.loom.com/share/abc',
      });

    expect(submit.status).toBe(200);

    const submission = await ExamSubmission.findOne({
      userId: learner.userId,
      courseId,
    });

    return {
      admin,
      learner,
      courseId,
      lessonId,
      submissionId: submission!._id.toString(),
    };
  }

  it("a 'user' gets FORBIDDEN on every admin grading endpoint", async () => {
    const { learner, submissionId } = await seedSubmittedExam();

    const list = await request(app)
      .get('/api/admin/exam-submissions')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');

    const detail = await request(app)
      .get(`/api/admin/exam-submissions/${submissionId}`)
      .set('Authorization', `Bearer ${learner.token}`);
    expect(detail.status).toBe(403);

    const grade = await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${learner.token}`)
      .send({ marksAwarded: 40 });
    expect(grade.status).toBe(403);
  });

  it('grading awards marks to totalPoints exactly once, even on concurrent double-submit', async () => {
    const { admin, learner, submissionId } = await seedSubmittedExam();

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/admin/exam-submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ marksAwarded: 42, feedback: 'Solid work' }),
      request(app)
        .post(`/api/admin/exam-submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ marksAwarded: 42, feedback: 'Solid work' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);

    const ok = first.status === 200 ? first : second;
    const fail = first.status === 200 ? second : first;
    expect(ok.body.pointsAwarded).toBe(42);
    expect(fail.body.error.code).toBe('VALIDATION_ERROR');
    expect(fail.body.error.message).toMatch(/already been graded/i);

    const user = await User.findById(learner.userId);
    expect(user!.totalPoints).toBe(RULES.VIDEO_POINTS + 42);
  });

  it(
    '40 out of 50 passes and creates a badge; 39 fails and creates none',
    async () => {
      const passCase = await seedSubmittedExam({ learnerEmail: 'pass@rva.test' });
      const passRes = await request(app)
        .post(`/api/admin/exam-submissions/${passCase.submissionId}/grade`)
        .set('Authorization', `Bearer ${passCase.admin.token}`)
        .send({ marksAwarded: 40 });
      expect(passRes.status).toBe(200);
      expect(passRes.body.submission.passed).toBe(true);
      expect(passRes.body.badgeCreated).toBe(true);
      expect(passRes.body.badge).toMatchObject({
        courseId: passCase.courseId,
        marksAwarded: 40,
        maxMarks: 50,
      });
      expect(await Badge.countDocuments({ userId: passCase.learner.userId })).toBe(1);

      const failCase = await seedSubmittedExam({ learnerEmail: 'fail@rva.test' });
      const failRes = await request(app)
        .post(`/api/admin/exam-submissions/${failCase.submissionId}/grade`)
        .set('Authorization', `Bearer ${failCase.admin.token}`)
        .send({ marksAwarded: 39 });
      expect(failRes.status).toBe(200);
      expect(failRes.body.submission.passed).toBe(false);
      expect(failRes.body.badgeCreated).toBe(false);
      expect(failRes.body.badge).toBeNull();
      expect(await Badge.countDocuments({ userId: failCase.learner.userId })).toBe(0);
    },
    15_000,
  );

  it('grading an already-graded submission is rejected', async () => {
    const { admin, submissionId } = await seedSubmittedExam();
    const first = await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 45 });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 50 });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/already been graded/i);
  });

  it('marks below 0, above 50, or non-integer are rejected', async () => {
    const { admin, submissionId } = await seedSubmittedExam();

    for (const marksAwarded of [-1, 51, 40.5, 12.2]) {
      const res = await request(app)
        .post(`/api/admin/exam-submissions/${submissionId}/grade`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ marksAwarded });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    const still = await ExamSubmission.findById(submissionId);
    expect(still!.status).toBe('submitted');
  });

  it('the badge unique index prevents two badges for the same user and course', async () => {
    const { learner, courseId, submissionId } = await seedSubmittedExam();
    await Badge.create({
      userId: learner.userId,
      courseId,
      courseTitle: 'Grading Course',
      examSubmissionId: submissionId,
      marksAwarded: 40,
      maxMarks: 50,
      earnedAt: new Date(),
    });

    await expect(
      Badge.create({
        userId: learner.userId,
        courseId,
        courseTitle: 'Grading Course',
        examSubmissionId: submissionId,
        marksAwarded: 50,
        maxMarks: 50,
        earnedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('the learner can no longer replace a submission once graded', async () => {
    const { admin, learner, courseId, submissionId } = await seedSubmittedExam();
    await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 40 });

    const replace = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${learner.token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/new' });
    expect(replace.status).toBe(400);
    expect(replace.body.error.message).toMatch(/graded/i);
  });

  it('totalPoints still equals video points plus quiz points plus awarded exam marks', async () => {
    const { admin, learner, courseId, lessonId, submissionId } =
      await seedSubmittedExam({ learnerEmail: 'sum@rva.test' });

    // Award a lesson quiz delta of 3
    const quiz = await Quiz.create({
      scope: 'lesson',
      courseId,
      lessonId,
      title: 'Check-in',
      pointsPerQuestion: 1,
      passingScorePct: 70,
      maxAttempts: null,
      questions: [
        {
          text: 'A?',
          options: ['1', '2'],
          correctIndex: 0,
          order: 10,
        },
        {
          text: 'B?',
          options: ['1', '2'],
          correctIndex: 0,
          order: 20,
        },
        {
          text: 'C?',
          options: ['1', '2'],
          correctIndex: 0,
          order: 30,
        },
      ],
    });

    await Progress.updateOne(
      { userId: learner.userId, courseId },
      {
        $set: {
          'lessons.0.bestQuizScore': 3,
          'lessons.0.quizPointsAwarded': 3,
          'lessons.0.attempts': 1,
        },
      },
    );
    await QuizAttempt.create({
      userId: learner.userId,
      lessonId,
      quizId: quiz._id,
      answers: [0, 0, 0],
      score: 3,
      maxScore: 3,
      correctCount: 3,
      pointsDelta: 3,
      attemptNumber: 1,
    });
    await User.updateOne({ _id: learner.userId }, { $inc: { totalPoints: 3 } });

    await request(app)
      .post(`/api/admin/exam-submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ marksAwarded: 41 });

    const user = await User.findById(learner.userId);
    const videoPts = RULES.VIDEO_POINTS;
    const quizPts = 3;
    const examPts = 41;
    expect(user!.totalPoints).toBe(videoPts + quizPts + examPts);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(me.body.user.totalPoints).toBe(videoPts + quizPts + examPts);
    expect(me.body.user.badges).toHaveLength(1);

    const progress = await request(app)
      .get('/api/progress')
      .set('Authorization', `Bearer ${learner.token}`);
    expect(progress.body.totals.totalPoints).toBe(videoPts + quizPts + examPts);
    expect(progress.body.badges).toHaveLength(1);
  });

  it('list defaults to ungraded queue and graded detail includes links', async () => {
    const { admin, submissionId } = await seedSubmittedExam();

    const list = await request(app)
      .get('/api/admin/exam-submissions')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.meta.ungradedCount).toBe(1);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].status).toBe('submitted');

    const detail = await request(app)
      .get(`/api/admin/exam-submissions/${submissionId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.submission.docUrl).toMatch(/^https:\/\//);
    expect(detail.body.submission.loomUrl).toMatch(/^https:\/\//);
    expect(detail.body.submission.exam.questions.length).toBeGreaterThan(0);
  });
});
