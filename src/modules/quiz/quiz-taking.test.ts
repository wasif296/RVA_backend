import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../../shared/index.js';
import { createApp } from '../../app.js';
import { Course } from '../../models/Course.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { Quiz } from '../../models/Quiz.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { User } from '../../models/User.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

describe('Phase 14A quiz taking / scoring', () => {
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
      Quiz.deleteMany({}),
      QuizAttempt.deleteMany({}),
      ExamSubmission.deleteMany({}),
      Progress.deleteMany({}),
    ]);
  });

  async function loginAs(role: 'super_admin' | 'user', email: string) {
    const password = 'test-password-12';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await User.create({
      name: role === 'super_admin' ? 'Admin' : 'Learner',
      email,
      passwordHash,
      role,
      mustChangePassword: false,
    });
    const login = await request(app).post('/api/auth/login').send({ email, password });
    return login.body.accessToken as string;
  }

  async function seedPublishedCourse(opts?: {
    lessonCount?: number;
    withLessonQuiz?: boolean;
    withFinalExam?: boolean;
    quizQuestions?: number;
  }) {
    const lessonCount = opts?.lessonCount ?? 2;
    const quizQuestions = opts?.quizQuestions ?? 10;
    const adminToken = await loginAs(
      'super_admin',
      `admin-${Date.now()}-${Math.random().toString(16).slice(2)}@rva.test`,
    );

    const courseRes = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Taking Course',
        description: 'For quiz taking',
        category: 'Foundations',
        level: 'beginner',
      });
    const courseId = courseRes.body.course.id as string;

    const lessonIds: string[] = [];
    for (let i = 0; i < lessonCount; i += 1) {
      const lesson = await request(app)
        .post(`/api/courses/${courseId}/lessons`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: `Lesson ${i + 1}`,
          description: 'Desc',
          youtubeVideoId: VIDEO_ID,
          durationSec: 100,
        });
      lessonIds.push(lesson.body.lesson.id as string);
    }

    await request(app)
      .patch(`/api/courses/${courseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'published' });

    if (opts?.withLessonQuiz !== false) {
      await request(app)
        .put(`/api/lessons/${lessonIds[0]!}/quiz`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Lesson Quiz',
          pointsPerQuestion: 1,
          passingScorePct: 70,
          questions: Array.from({ length: quizQuestions }, (_, index) => ({
            text: `Q${index + 1} UNIQUE_TEXT_${index}`,
            options: ['A', 'B', 'C', 'D'],
            // correct is always index 0 ('A') for easy assertions
            correctIndex: 0,
          })),
        });
    }

    if (opts?.withFinalExam) {
      await request(app)
        .put(`/api/courses/${courseId}/final-exam`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Final Exam',
          instructions: 'Answer in a Google Doc and submit the link.',
          questions: Array.from({ length: Math.max(1, lessonCount) }, (_, index) => ({
            text: `Final written Q${index + 1} SECRET_${index}`,
          })),
        });
    }

    return { adminToken, courseId, lessonIds };
  }

  async function completeLessonVideo(
    userId: string,
    courseId: string,
    lessonId: string,
  ) {
    const existing = await Progress.findOne({ userId, courseId });
    if (!existing) {
      await Progress.create({
        userId,
        courseId,
        startedAt: new Date(),
        lastLessonId: lessonId,
        lessons: [
          {
            lessonId,
            watchedSec: 100,
            videoCompletedAt: new Date(),
            videoPointsAwarded: true,
            bestQuizScore: 0,
            quizPointsAwarded: 0,
            attempts: 0,
          },
        ],
      });
      return;
    }

    const entry = existing.lessons.find((row) => row.lessonId.toString() === lessonId);
    if (entry) {
      entry.watchedSec = Math.max(entry.watchedSec, 100);
      entry.videoCompletedAt = entry.videoCompletedAt ?? new Date();
      entry.videoPointsAwarded = true;
    } else {
      existing.lessons.push({
        lessonId: new mongoose.Types.ObjectId(lessonId),
        watchedSec: 100,
        videoCompletedAt: new Date(),
        videoPointsAwarded: true,
        bestQuizScore: 0,
        quizPointsAwarded: 0,
        attempts: 0,
      });
    }
    existing.lastLessonId = new mongoose.Types.ObjectId(lessonId);
    await existing.save();
  }

  async function completeAllVideos(userId: string, courseId: string, lessonIds: string[]) {
    await Progress.create({
      userId,
      courseId,
      startedAt: new Date(),
      lessons: lessonIds.map((id) => ({
        lessonId: id,
        watchedSec: 100,
        videoCompletedAt: new Date(),
        videoPointsAwarded: true,
        bestQuizScore: 0,
        quizPointsAwarded: 0,
        attempts: 0,
      })),
    });
    await User.updateOne(
      { _id: userId },
      { $inc: { totalPoints: lessonIds.length * RULES.VIDEO_POINTS } },
    );
  }

  it('the serialised GET quiz response contains no "correctIndex" substring', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 3 });
    const token = await loginAs('user', 'get-quiz@rva.test');
    const user = await User.findOne({ email: 'get-quiz@rva.test' });
    await completeLessonVideo(user!._id.toString(), courseId, lessonIds[0]!);

    const res = await request(app)
      .get(`/api/lessons/${lessonIds[0]!}/quiz`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.quiz.questions).toHaveLength(3);
    expect(res.body.quiz.questions[0]).toHaveProperty('options');
    expect(res.body.quiz.questions[0]).toHaveProperty('text');
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('correctIndex');
  });

  it('GET final-exam returns text questions only (no options/correctIndex)', async () => {
    const { courseId } = await seedPublishedCourse({
      lessonCount: 2,
      withLessonQuiz: false,
      withFinalExam: true,
    });
    const token = await loginAs('user', 'get-final@rva.test');

    const res = await request(app)
      .get(`/api/courses/${courseId}/final-exam`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.exam).toBeDefined();
    expect(res.body.quiz).toBeUndefined();
    expect(res.body.exam.maxMarks).toBe(50);
    expect(res.body.exam.passMark).toBe(40);
    expect(res.body.exam.questions.length).toBeGreaterThan(0);
    expect(res.body.exam.questions[0]).toHaveProperty('text');
    expect(res.body.exam.questions[0]).not.toHaveProperty('options');
    expect(res.body.exam.questions[0]).not.toHaveProperty('correctIndex');
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('correctIndex');
    expect(json).not.toContain('"options"');
  });

  it('scoring is correct for all-right, all-wrong and partial', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 4 });
    const token = await loginAs('user', 'score@rva.test');
    const user = await User.findOne({ email: 'score@rva.test' });
    const lessonId = lessonIds[0]!;
    await completeLessonVideo(user!._id.toString(), courseId, lessonId);

    const allRight = await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 0] });
    expect(allRight.status).toBe(200);
    expect(allRight.body).toMatchObject({
      correctCount: 4,
      score: 4,
      maxScore: 4,
      pointsDelta: 4,
      passed: true,
    });
    expect(allRight.body.breakdown).toHaveLength(4);
    expect(allRight.body.breakdown[0].correctIndex).toBe(0);

    // New user for all-wrong
    const wrongToken = await loginAs('user', 'wrong@rva.test');
    const wrongUser = await User.findOne({ email: 'wrong@rva.test' });
    await completeLessonVideo(wrongUser!._id.toString(), courseId, lessonId);
    const allWrong = await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${wrongToken}`)
      .send({ answers: [1, 1, 1, 1] });
    expect(allWrong.body).toMatchObject({
      correctCount: 0,
      score: 0,
      maxScore: 4,
      pointsDelta: 0,
      passed: false,
    });

    const partialToken = await loginAs('user', 'partial@rva.test');
    const partialUser = await User.findOne({ email: 'partial@rva.test' });
    await completeLessonVideo(partialUser!._id.toString(), courseId, lessonId);
    const partial = await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${partialToken}`)
      .send({ answers: [0, 0, 1, 1] });
    expect(partial.body).toMatchObject({
      correctCount: 2,
      score: 2,
      maxScore: 4,
      pointsDelta: 2,
    });
  });

  it('unanswered nulls score zero and do not crash', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 3 });
    const token = await loginAs('user', 'nulls@rva.test');
    const user = await User.findOne({ email: 'nulls@rva.test' });
    await completeLessonVideo(user!._id.toString(), courseId, lessonIds[0]!);

    const res = await request(app)
      .post(`/api/lessons/${lessonIds[0]!}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [null, null, null] });

    expect(res.status).toBe(200);
    expect(res.body.correctCount).toBe(0);
    expect(res.body.score).toBe(0);
    expect(res.body.breakdown.every((b: { isCorrect: boolean }) => !b.isCorrect)).toBe(
      true,
    );
  });

  it('a wrong-length answers array is rejected', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 3 });
    const token = await loginAs('user', 'len@rva.test');
    const user = await User.findOne({ email: 'len@rva.test' });
    await completeLessonVideo(user!._id.toString(), courseId, lessonIds[0]!);

    const res = await request(app)
      .post(`/api/lessons/${lessonIds[0]!}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('an out-of-range option index is rejected', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 2 });
    const token = await loginAs('user', 'oor@rva.test');
    const user = await User.findOne({ email: 'oor@rva.test' });
    await completeLessonVideo(user!._id.toString(), courseId, lessonIds[0]!);

    const res = await request(app)
      .post(`/api/lessons/${lessonIds[0]!}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 99] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('6/10 then 9/10 awards 6 then 3 points, and totalPoints is 9 not 15', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 10 });
    const token = await loginAs('user', 'delta-up@rva.test');
    const user = await User.findOne({ email: 'delta-up@rva.test' });
    const lessonId = lessonIds[0]!;
    await completeLessonVideo(user!._id.toString(), courseId, lessonId);

    const first = await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] });
    expect(first.body.score).toBe(6);
    expect(first.body.pointsDelta).toBe(6);

    const second = await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1] });
    expect(second.body.score).toBe(9);
    expect(second.body.pointsDelta).toBe(3);

    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(9);
  });

  it('9/10 then 6/10 awards 9 then 0, and bestQuizScore stays 9', async () => {
    const { lessonIds, courseId } = await seedPublishedCourse({ quizQuestions: 10 });
    const token = await loginAs('user', 'delta-down@rva.test');
    const user = await User.findOne({ email: 'delta-down@rva.test' });
    const lessonId = lessonIds[0]!;
    await completeLessonVideo(user!._id.toString(), courseId, lessonId);

    await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1] });

    const second = await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] });
    expect(second.body.score).toBe(6);
    expect(second.body.pointsDelta).toBe(0);

    const progress = await Progress.findOne({ userId: user!._id, courseId });
    const entry = progress!.lessons.find((l) => l.lessonId.toString() === lessonId);
    expect(entry!.bestQuizScore).toBe(9);

    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(9);
  });

  it('a failing score still awards its points', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 10 });
    const token = await loginAs('user', 'fail-pts@rva.test');
    const user = await User.findOne({ email: 'fail-pts@rva.test' });
    await completeLessonVideo(user!._id.toString(), courseId, lessonIds[0]!);

    const res = await request(app)
      .post(`/api/lessons/${lessonIds[0]!}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1] });

    expect(res.body.score).toBe(3);
    expect(res.body.passed).toBe(false);
    expect(res.body.pointsDelta).toBe(3);

    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(3);
  });

  it('written final exam submission is rejected until all videos are complete', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({
      lessonCount: 2,
      withLessonQuiz: false,
      withFinalExam: true,
    });
    const token = await loginAs('user', 'exam-locked@rva.test');
    const user = await User.findOne({ email: 'exam-locked@rva.test' });

    await Progress.create({
      userId: user!._id,
      courseId,
      lessons: [
        {
          lessonId: lessonIds[0]!,
          watchedSec: 100,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const res = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/abc' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/every lesson video/i);
  });

  it('non-https docUrl and missing docUrl are rejected; missing loomUrl is fine', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({
      lessonCount: 1,
      withLessonQuiz: false,
      withFinalExam: true,
    });
    const token = await loginAs('user', 'exam-urls@rva.test');
    const user = await User.findOne({ email: 'exam-urls@rva.test' });
    await completeAllVideos(user!._id.toString(), courseId, lessonIds);

    const httpOnly = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ docUrl: 'http://example.com/doc' });
    expect(httpOnly.status).toBe(400);
    expect(httpOnly.body.error.code).toBe('VALIDATION_ERROR');

    const missing = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    const ok = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/ok' });
    expect(ok.status).toBe(200);
    expect(ok.body.submission.docUrl).toBe('https://docs.google.com/document/d/ok');
    expect(ok.body.submission.loomUrl).toBeNull();
    expect(ok.body.submission.status).toBe('submitted');
  });

  it('second submission replaces while ungraded; after graded, submit is rejected', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({
      lessonCount: 1,
      withLessonQuiz: false,
      withFinalExam: true,
    });
    const token = await loginAs('user', 'exam-replace@rva.test');
    const user = await User.findOne({ email: 'exam-replace@rva.test' });
    await completeAllVideos(user!._id.toString(), courseId, lessonIds);

    const first = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        docUrl: 'https://docs.google.com/document/d/first',
        loomUrl: 'https://www.loom.com/share/aaa',
      });
    expect(first.status).toBe(200);
    const firstId = first.body.submission.id as string;

    const second = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/second' });
    expect(second.status).toBe(200);
    expect(second.body.submission.id).toBe(firstId);
    expect(second.body.submission.docUrl).toBe('https://docs.google.com/document/d/second');
    expect(second.body.submission.loomUrl).toBeNull();
    expect(await ExamSubmission.countDocuments({ userId: user!._id, courseId })).toBe(1);

    await ExamSubmission.updateOne(
      { _id: firstId },
      {
        $set: {
          status: 'graded',
          marksAwarded: 42,
          passed: true,
          gradedAt: new Date(),
        },
      },
    );

    const rejected = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/third' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    expect(rejected.body.error.message).toMatch(/graded/i);

    const get = await request(app)
      .get(`/api/courses/${courseId}/final-exam/submission`)
      .set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.submission.status).toBe('graded');
    expect(get.body.submission.marksAwarded).toBe(42);
  });

  it('unique index prevents duplicate exam submissions', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({
      lessonCount: 1,
      withLessonQuiz: false,
      withFinalExam: true,
    });
    const token = await loginAs('user', 'exam-unique@rva.test');
    const user = await User.findOne({ email: 'exam-unique@rva.test' });
    await completeAllVideos(user!._id.toString(), courseId, lessonIds);

    await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/one' });

    const exam = await Quiz.findOne({ courseId, scope: 'final_exam' });
    await expect(
      ExamSubmission.create({
        userId: user!._id,
        courseId,
        examId: exam!._id,
        docUrl: 'https://docs.google.com/document/d/dup',
        status: 'submitted',
        submittedAt: new Date(),
        maxMarks: 50,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('written submission awards no points', async () => {
    const { courseId, lessonIds } = await seedPublishedCourse({
      lessonCount: 1,
      withLessonQuiz: false,
      withFinalExam: true,
    });
    const token = await loginAs('user', 'exam-nopoints@rva.test');
    const user = await User.findOne({ email: 'exam-nopoints@rva.test' });
    await completeAllVideos(user!._id.toString(), courseId, lessonIds);

    const before = await User.findById(user!._id);
    const pointsBefore = before!.totalPoints;

    const res = await request(app)
      .post(`/api/courses/${courseId}/final-exam/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ docUrl: 'https://docs.google.com/document/d/nopoints' });

    expect(res.status).toBe(200);
    expect(res.body.submission.status).toBe('submitted');
    expect(res.body.submission.marksAwarded).toBeNull();

    const after = await User.findById(user!._id);
    expect(after!.totalPoints).toBe(pointsBefore);
  });

  it('editing a quiz after attempts exist does not change historical attempt scores', async () => {
    const { adminToken, courseId, lessonIds } = await seedPublishedCourse({
      quizQuestions: 2,
    });
    const token = await loginAs('user', 'freeze@rva.test');
    const user = await User.findOne({ email: 'freeze@rva.test' });
    const lessonId = lessonIds[0]!;
    await completeLessonVideo(user!._id.toString(), courseId, lessonId);

    const submit = await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0] });
    expect(submit.body.score).toBe(2);
    expect(submit.body.maxScore).toBe(2);

    // Admin expands quiz to 4 questions (maxScore would be 4 if rescored)
    await request(app)
      .put(`/api/lessons/${lessonId}/quiz`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Lesson Quiz',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: [
          { text: 'NQ1', options: ['A', 'B'], correctIndex: 0 },
          { text: 'NQ2', options: ['A', 'B'], correctIndex: 0 },
          { text: 'NQ3', options: ['A', 'B'], correctIndex: 0 },
          { text: 'NQ4', options: ['A', 'B'], correctIndex: 0 },
        ],
      });

    const history = await request(app)
      .get(`/api/lessons/${lessonId}/quiz/attempts`)
      .set('Authorization', `Bearer ${token}`);

    expect(history.body.attempts).toHaveLength(1);
    expect(history.body.attempts[0].score).toBe(2);
    expect(history.body.attempts[0].maxScore).toBe(2);
  });

  it("a user cannot submit against another user's progress", async () => {
    const { lessonIds, courseId } = await seedPublishedCourse({ quizQuestions: 2 });
    const aliceToken = await loginAs('user', 'alice-q@rva.test');
    const bobToken = await loginAs('user', 'bob-q@rva.test');
    const alice = await User.findOne({ email: 'alice-q@rva.test' });
    const bob = await User.findOne({ email: 'bob-q@rva.test' });
    const lessonId = lessonIds[0]!;
    await completeLessonVideo(alice!._id.toString(), courseId, lessonId);
    await completeLessonVideo(bob!._id.toString(), courseId, lessonId);

    await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ answers: [0, 0], userId: bob!._id.toString() });

    await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ answers: [1, 1], userId: alice!._id.toString() });

    const aliceProgress = await Progress.findOne({ userId: alice!._id, courseId });
    const bobProgress = await Progress.findOne({ userId: bob!._id, courseId });
    const aliceEntry = aliceProgress!.lessons.find(
      (l) => l.lessonId.toString() === lessonId,
    );
    const bobEntry = bobProgress!.lessons.find((l) => l.lessonId.toString() === lessonId);

    expect(aliceEntry!.bestQuizScore).toBe(2);
    expect(bobEntry!.bestQuizScore).toBe(0);

    const aliceUser = await User.findById(alice!._id);
    const bobUser = await User.findById(bob!._id);
    expect(aliceUser!.totalPoints).toBe(2);
    expect(bobUser!.totalPoints).toBe(0);
  });

  it('User.totalPoints always equals the sum of video awards plus quiz deltas', async () => {
    const { lessonIds, courseId } = await seedPublishedCourse({ quizQuestions: 10 });
    const token = await loginAs('user', 'sum-pts@rva.test');
    const user = await User.findOne({ email: 'sum-pts@rva.test' });
    const lessonId = lessonIds[0]!;

    // Simulate one video award
    await Progress.create({
      userId: user!._id,
      courseId,
      lessons: [
        {
          lessonId,
          watchedSec: 90,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    await User.updateOne({ _id: user!._id }, { $set: { totalPoints: RULES.VIDEO_POINTS } });

    await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] }); // 6 pts

    await request(app)
      .post(`/api/lessons/${lessonId}/quiz/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }); // +3 delta

    const progress = await Progress.findOne({ userId: user!._id, courseId });
    const entry = progress!.lessons.find((l) => l.lessonId.toString() === lessonId)!;
    const videoPts = entry.videoPointsAwarded ? RULES.VIDEO_POINTS : 0;
    const quizPts = entry.quizPointsAwarded;
    const refreshed = await User.findById(user!._id);

    expect(quizPts).toBe(9);
    expect(refreshed!.totalPoints).toBe(videoPts + quizPts);
    expect(refreshed!.totalPoints).toBe(5 + 9);
  });

  describe('lesson quiz available without video progress', () => {
    it('GET and POST succeed with zero video progress', async () => {
      const { courseId, lessonIds } = await seedPublishedCourse({ quizQuestions: 2 });
      const token = await loginAs('user', 'quiz-no-video@rva.test');
      const user = await User.findOne({ email: 'quiz-no-video@rva.test' });
      const lessonId = lessonIds[0]!;

      expect(await Progress.findOne({ userId: user!._id, courseId })).toBeNull();

      const getRes = await request(app)
        .get(`/api/lessons/${lessonId}/quiz`)
        .set('Authorization', `Bearer ${token}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.quiz.questions).toHaveLength(2);

      const postRes = await request(app)
        .post(`/api/lessons/${lessonId}/quiz/submit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ answers: [0, 0] });
      expect(postRes.status).toBe(200);
      expect(postRes.body.pointsDelta).toBe(2);
      expect(await QuizAttempt.countDocuments({ userId: user!._id })).toBe(1);
    });

    it('lesson and course-detail payloads do not include quizUnlocked', async () => {
      const { courseId, lessonIds } = await seedPublishedCourse({
        quizQuestions: 2,
        lessonCount: 1,
      });
      const token = await loginAs('user', 'no-quiz-unlocked-field@rva.test');

      const lessonRes = await request(app)
        .get(`/api/lessons/${lessonIds[0]!}`)
        .set('Authorization', `Bearer ${token}`);
      expect(lessonRes.status).toBe(200);
      expect(lessonRes.body.lesson).not.toHaveProperty('quizUnlocked');

      const courseRes = await request(app)
        .get(`/api/courses/${courseId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(courseRes.status).toBe(200);
      expect(courseRes.body.lessons[0]).not.toHaveProperty('quizUnlocked');
    });
  });
});
