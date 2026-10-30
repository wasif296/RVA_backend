import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Quiz } from '../../models/Quiz.js';
import { User } from '../../models/User.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

function sampleQuestions(count = 2, prefix = 'Question') {
  return Array.from({ length: count }, (_, index) => ({
    text: `${prefix} ${index + 1}`,
    options: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
    correctIndex: index % 4,
  }));
}

function sampleExamQuestions(count = 2, prefix = 'Exam Q') {
  return Array.from({ length: count }, (_, index) => ({
    text: `${prefix} ${index + 1}`,
  }));
}

describe('Phase 8 quiz + final exam builder', () => {
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

  async function seedCourseWithLessons(lessonCount = 2) {
    const adminToken = await loginAs(
      'super_admin',
      `admin-${Date.now()}-${Math.random().toString(16).slice(2)}@rva.test`,
    );
    const course = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Quiz Course',
        description: 'For quiz tests',
        category: 'Foundations',
        level: 'beginner',
      });

    const lessonIds: string[] = [];
    for (let i = 0; i < lessonCount; i += 1) {
      const lesson = await request(app)
        .post(`/api/courses/${course.body.course.id}/lessons`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: `Lesson ${i + 1}`,
          description: 'Desc',
          youtubeVideoId: VIDEO_ID,
          durationSec: 120,
        });
      lessonIds.push(lesson.body.lesson.id as string);
    }

    return {
      adminToken,
      courseId: course.body.course.id as string,
      lessonIds,
    };
  }

  it('GET quiz/admin includes correctIndex; GET final-exam/admin returns { exam } text-only', async () => {
    const { adminToken, courseId, lessonIds } = await seedCourseWithLessons(2);
    const headers = { Authorization: `Bearer ${adminToken}` };
    const lessonId = lessonIds[0]!;

    await request(app)
      .put(`/api/lessons/${lessonId}/quiz`)
      .set(headers)
      .send({
        title: 'Lesson quiz',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: sampleQuestions(2),
      });

    await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send({
        title: 'Final exam',
        instructions: 'Write your answers in a doc.',
        questions: sampleExamQuestions(3, 'Final'),
      });

    const lessonQuiz = await request(app)
      .get(`/api/lessons/${lessonId}/quiz/admin`)
      .set(headers);
    const finalExam = await request(app)
      .get(`/api/courses/${courseId}/final-exam/admin`)
      .set(headers);

    expect(lessonQuiz.status).toBe(200);
    expect(lessonQuiz.body.quiz.questions[0]).toHaveProperty('correctIndex');
    expect(lessonQuiz.body.quiz.questions[0].correctIndex).toBe(0);

    expect(finalExam.status).toBe(200);
    expect(finalExam.body.exam).toBeDefined();
    expect(finalExam.body.quiz).toBeUndefined();
    expect(finalExam.body.exam.questions[0]).not.toHaveProperty('correctIndex');
    expect(finalExam.body.exam.questions[0]).not.toHaveProperty('options');
    expect(finalExam.body.exam.questions[0]).toHaveProperty('text');
    expect(finalExam.body.exam.maxMarks).toBe(50);
    expect(finalExam.body.exam.passMark).toBe(40);
  });

  it("a 'user' role gets FORBIDDEN on every endpoint in this module", async () => {
    const { adminToken, courseId, lessonIds } = await seedCourseWithLessons(1);
    const lessonId = lessonIds[0]!;
    await request(app)
      .put(`/api/lessons/${lessonId}/quiz`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Locked',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: sampleQuestions(1),
      });
    await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Final',
        instructions: '',
        questions: sampleExamQuestions(1, 'Final'),
      });

    const userToken = await loginAs('user', 'learner-quiz@rva.test');
    const headers = { Authorization: `Bearer ${userToken}` };
    const lessonBody = {
      title: 'Nope',
      pointsPerQuestion: 1,
      passingScorePct: 70,
      questions: sampleQuestions(1),
    };
    const examBody = {
      title: 'Nope',
      instructions: '',
      questions: sampleExamQuestions(1),
    };

    const calls = [
      request(app).get(`/api/lessons/${lessonId}/quiz/admin`).set(headers),
      request(app).put(`/api/lessons/${lessonId}/quiz`).set(headers).send(lessonBody),
      request(app).delete(`/api/lessons/${lessonId}/quiz`).set(headers),
      request(app).get(`/api/courses/${courseId}/final-exam/admin`).set(headers),
      request(app).put(`/api/courses/${courseId}/final-exam`).set(headers).send(examBody),
      request(app).delete(`/api/courses/${courseId}/final-exam`).set(headers),
    ];
    const results = await Promise.all(calls);
    for (const res of results) {
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('a plain Quiz.findOne() with no explicit select does NOT return correctIndex', async () => {
    const { adminToken, lessonIds } = await seedCourseWithLessons(1);
    const lessonId = lessonIds[0]!;
    await request(app)
      .put(`/api/lessons/${lessonId}/quiz`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Hidden',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: sampleQuestions(1),
      });

    const plain = await Quiz.findOne({ lessonId }).lean();
    expect(plain).not.toBeNull();
    expect(plain!.questions[0]).not.toHaveProperty('correctIndex');
  });

  it('correctIndex equal to options.length is rejected', async () => {
    const { adminToken, lessonIds } = await seedCourseWithLessons(1);
    const res = await request(app)
      .put(`/api/lessons/${lessonIds[0]!}/quiz`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Bad index',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: [{ text: 'Which?', options: ['A', 'B'], correctIndex: 2 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('duplicate options within a question are rejected', async () => {
    const { adminToken, lessonIds } = await seedCourseWithLessons(1);
    const res = await request(app)
      .put(`/api/lessons/${lessonIds[0]!}/quiz`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Dup options',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: [{ text: 'Which?', options: ['Same', 'same'], correctIndex: 0 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('duplicate question text within a quiz is rejected', async () => {
    const { adminToken, lessonIds } = await seedCourseWithLessons(1);
    const res = await request(app)
      .put(`/api/lessons/${lessonIds[0]!}/quiz`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Dup questions',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: [
          { text: 'Same text', options: ['A', 'B'], correctIndex: 0 },
          { text: 'same text', options: ['C', 'D'], correctIndex: 1 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('exam text questions without options save; lesson quiz without options is rejected', async () => {
    const { adminToken, courseId, lessonIds } = await seedCourseWithLessons(1);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const exam = await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send({
        title: 'Written final',
        instructions: 'Submit a doc.',
        questions: [{ text: 'Explain your workflow.' }],
      });
    expect(exam.status).toBe(200);
    expect(exam.body.exam.questions).toHaveLength(1);
    expect(exam.body.exam.questions[0]).not.toHaveProperty('options');

    const stored = await Quiz.findById(exam.body.exam.id).lean();
    expect(stored?.questions[0]?.options).toEqual([]);
    expect(stored?.questions[0]).not.toHaveProperty('correctIndex');

    const lesson = await request(app)
      .put(`/api/lessons/${lessonIds[0]!}/quiz`)
      .set(headers)
      .send({
        title: 'Missing options',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: [{ text: 'Which?', correctIndex: 0 }],
      });
    expect(lesson.status).toBe(400);
    expect(lesson.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a second final exam on the same course is rejected by the partial unique index', async () => {
    const { adminToken, courseId } = await seedCourseWithLessons(1);
    const headers = { Authorization: `Bearer ${adminToken}` };
    const body = {
      title: 'Final A',
      instructions: '',
      questions: sampleExamQuestions(1, 'Final'),
    };
    const first = await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send(body);
    expect(first.status).toBe(200);

    await expect(
      Quiz.create({
        scope: 'final_exam',
        courseId,
        lessonId: null,
        title: 'Final B',
        instructions: '',
        pointsPerQuestion: 1,
        passingScorePct: 80,
        maxAttempts: null,
        questions: [
          {
            text: 'Extra',
            options: [],
            order: 10,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('two lesson quizzes on different lessons of the same course both save fine', async () => {
    const { adminToken, lessonIds } = await seedCourseWithLessons(2);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const a = await request(app)
      .put(`/api/lessons/${lessonIds[0]!}/quiz`)
      .set(headers)
      .send({
        title: 'Quiz A',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: sampleQuestions(1, 'A'),
      });
    const b = await request(app)
      .put(`/api/lessons/${lessonIds[1]!}/quiz`)
      .set(headers)
      .send({
        title: 'Quiz B',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: sampleQuestions(1, 'B'),
      });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.quiz.lessonId).toBe(lessonIds[0]);
    expect(b.body.quiz.lessonId).toBe(lessonIds[1]);
  });

  it('PUT with fewer questions deletes the removed ones', async () => {
    const { adminToken, lessonIds } = await seedCourseWithLessons(1);
    const headers = { Authorization: `Bearer ${adminToken}` };
    const lessonId = lessonIds[0]!;

    await request(app)
      .put(`/api/lessons/${lessonId}/quiz`)
      .set(headers)
      .send({
        title: 'Shrink',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: sampleQuestions(3),
      });

    const updated = await request(app)
      .put(`/api/lessons/${lessonId}/quiz`)
      .set(headers)
      .send({
        title: 'Shrink',
        pointsPerQuestion: 1,
        passingScorePct: 70,
        questions: [
          { text: 'Only survivor', options: ['Yes', 'No'], correctIndex: 0 },
        ],
      });

    expect(updated.status).toBe(200);
    expect(updated.body.quiz.questions).toHaveLength(1);
    expect(updated.body.quiz.questions[0].text).toBe('Only survivor');
  });

  it('saving a final exam twice updates it rather than erroring', async () => {
    const { adminToken, courseId } = await seedCourseWithLessons(1);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const first = await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send({
        title: 'Exam v1',
        instructions: 'First',
        questions: sampleExamQuestions(2, 'V1'),
      });
    expect(first.status).toBe(200);
    expect(first.body.exam.title).toBe('Exam v1');
    expect(first.body.exam.questions).toHaveLength(2);
    const examId = first.body.exam.id as string;

    const second = await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send({
        title: 'Exam v2',
        instructions: 'Edited',
        questions: sampleExamQuestions(3, 'V2'),
      });
    expect(second.status).toBe(200);
    expect(second.body.error).toBeUndefined();
    expect(second.body.exam.id).toBe(examId);
    expect(second.body.exam.title).toBe('Exam v2');
    expect(second.body.exam.instructions).toBe('Edited');
    expect(second.body.exam.questions).toHaveLength(3);
    expect(await Quiz.countDocuments({ courseId, scope: 'final_exam' })).toBe(1);
  });

  it('an exam created and then edited is readable by both the admin and the learner endpoints', async () => {
    const { adminToken, courseId } = await seedCourseWithLessons(1);
    const headers = { Authorization: `Bearer ${adminToken}` };

    await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send({
        title: 'Readable exam',
        instructions: 'Draft copy',
        questions: sampleExamQuestions(1, 'R'),
      });

    await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send({
        title: 'Readable exam edited',
        instructions: 'Go',
        questions: sampleExamQuestions(2, 'R'),
      });

    await request(app)
      .patch(`/api/courses/${courseId}`)
      .set(headers)
      .send({ status: 'published' });

    const adminGet = await request(app)
      .get(`/api/courses/${courseId}/final-exam/admin`)
      .set(headers);
    expect(adminGet.status).toBe(200);
    expect(adminGet.body.exam.title).toBe('Readable exam edited');
    expect(adminGet.body.exam.questions).toHaveLength(2);

    const learnerToken = await loginAs('user', `learner-exam-${Date.now()}@rva.test`);
    const learnerGet = await request(app)
      .get(`/api/courses/${courseId}/final-exam`)
      .set('Authorization', `Bearer ${learnerToken}`);
    expect(learnerGet.status).toBe(200);
    expect(learnerGet.body.exam.id).toBe(adminGet.body.exam.id);
    expect(learnerGet.body.exam.title).toBe('Readable exam edited');
    expect(learnerGet.body.exam.questions).toHaveLength(2);
  });

  it('admin and learner lookups agree about whether an exam exists for a given course', async () => {
    const { adminToken, courseId } = await seedCourseWithLessons(1);
    const headers = { Authorization: `Bearer ${adminToken}` };
    await request(app)
      .patch(`/api/courses/${courseId}`)
      .set(headers)
      .send({ status: 'published' });

    const learnerToken = await loginAs('user', `agree-${Date.now()}@rva.test`);
    const learnerHeaders = { Authorization: `Bearer ${learnerToken}` };

    const adminMissing = await request(app)
      .get(`/api/courses/${courseId}/final-exam/admin`)
      .set(headers);
    const learnerMissing = await request(app)
      .get(`/api/courses/${courseId}/final-exam`)
      .set(learnerHeaders);
    expect(adminMissing.status).toBe(404);
    expect(learnerMissing.status).toBe(404);

    await request(app)
      .put(`/api/courses/${courseId}/final-exam`)
      .set(headers)
      .send({
        title: 'Now exists',
        instructions: '',
        questions: sampleExamQuestions(1, 'E'),
      });

    const adminPresent = await request(app)
      .get(`/api/courses/${courseId}/final-exam/admin`)
      .set(headers);
    const learnerPresent = await request(app)
      .get(`/api/courses/${courseId}/final-exam`)
      .set(learnerHeaders);
    expect(adminPresent.status).toBe(200);
    expect(learnerPresent.status).toBe(200);
    expect(adminPresent.body.exam.id).toBe(learnerPresent.body.exam.id);
  });

  it('two different courses can each have a final exam', async () => {
    const a = await seedCourseWithLessons(1);
    const b = await seedCourseWithLessons(1);

    const first = await request(app)
      .put(`/api/courses/${a.courseId}/final-exam`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        title: 'Course A exam',
        instructions: '',
        questions: sampleExamQuestions(1, 'A'),
      });
    const second = await request(app)
      .put(`/api/courses/${b.courseId}/final-exam`)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .send({
        title: 'Course B exam',
        instructions: '',
        questions: sampleExamQuestions(1, 'B'),
      });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.exam.id).not.toBe(second.body.exam.id);
  });
});
