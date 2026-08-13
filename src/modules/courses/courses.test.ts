import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { Quiz } from '../../models/Quiz.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { User } from '../../models/User.js';
import { slugify } from '../../utils/slugify.js';
import {
  resetStorageAdapterForTests,
  setStorageAdapter,
  type StorageAdapter,
} from '../uploads/storage.adapter.js';

describe('Phase 7A courses', () => {
  let mongod: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Course.deleteMany({}),
      Progress.deleteMany({}),
      Lesson.deleteMany({}),
      Quiz.deleteMany({}),
      QuizAttempt.deleteMany({}),
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

  async function seedCourses(adminId: string) {
    await Course.create([
      {
        title: 'Published VA Basics',
        slug: 'published-va-basics',
        description: 'Visible to learners',
        category: 'Foundations',
        level: 'beginner',
        status: 'published',
        lessonCount: 2,
        createdBy: adminId,
      },
      {
        title: 'Draft Advanced Ops',
        slug: 'draft-advanced-ops',
        description: 'Hidden draft',
        category: 'Operations',
        level: 'advanced',
        status: 'draft',
        lessonCount: 0,
        createdBy: adminId,
      },
      {
        title: 'Archived Legacy',
        slug: 'archived-legacy',
        description: 'Old course',
        category: 'Foundations',
        level: 'intermediate',
        status: 'archived',
        lessonCount: 1,
        createdBy: adminId,
      },
    ]);
  }

  it("a 'user' listing courses never sees draft or archived ones", async () => {
    const adminToken = await loginAs('super_admin', 'admin@rva.test');
    const admin = await User.findOne({ email: 'admin@rva.test' });
    await seedCourses(admin!._id.toString());
    const userToken = await loginAs('user', 'learner@rva.test');

    const res = await request(app)
      .get('/api/courses')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('published');
    expect(res.body.data.every((c: { status: string }) => c.status === 'published')).toBe(
      true,
    );

    const adminList = await request(app)
      .get('/api/courses')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("a 'user' fetching a draft course by id gets NOT_FOUND, not FORBIDDEN", async () => {
    const admin = await User.create({
      name: 'Admin',
      email: 'admin2@rva.test',
      passwordHash: await argon2.hash('test-password-12', { type: argon2.argon2id }),
      role: 'super_admin',
    });
    const draft = await Course.create({
      title: 'Secret Draft',
      slug: 'secret-draft',
      description: 'Nope',
      category: 'Ops',
      level: 'beginner',
      status: 'draft',
      createdBy: admin._id,
    });
    const userToken = await loginAs('user', 'learner2@rva.test');

    const res = await request(app)
      .get(`/api/courses/${draft._id.toString()}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it("a 'user' gets FORBIDDEN on create, patch, and delete", async () => {
    const userToken = await loginAs('user', 'learner3@rva.test');
    const headers = { Authorization: `Bearer ${userToken}` };

    const create = await request(app).post('/api/courses').set(headers).send({
      title: 'Nope',
      description: 'Nope',
      category: 'X',
      level: 'beginner',
    });
    const patch = await request(app)
      .patch('/api/courses/507f1f77bcf86cd799439011')
      .set(headers)
      .send({ title: 'Nope' });
    const del = await request(app)
      .delete('/api/courses/507f1f77bcf86cd799439011')
      .set(headers);

    expect(create.body.error.code).toBe('FORBIDDEN');
    expect(patch.body.error.code).toBe('FORBIDDEN');
    expect(del.body.error.code).toBe('FORBIDDEN');
  });

  it('slug collisions produce course-2, course-3', async () => {
    const adminToken = await loginAs('super_admin', 'admin3@rva.test');
    const headers = { Authorization: `Bearer ${adminToken}` };
    const body = {
      title: 'Remote Skills',
      description: 'A course',
      category: 'Foundations',
      level: 'beginner' as const,
    };

    const first = await request(app).post('/api/courses').set(headers).send(body);
    const second = await request(app).post('/api/courses').set(headers).send(body);
    const third = await request(app).post('/api/courses').set(headers).send(body);

    expect(first.body.course.slug).toBe(slugify('Remote Skills'));
    expect(second.body.course.slug).toBe(`${slugify('Remote Skills')}-2`);
    expect(third.body.course.slug).toBe(`${slugify('Remote Skills')}-3`);
  });

  it('renaming a course leaves its slug unchanged', async () => {
    const adminToken = await loginAs('super_admin', 'admin4@rva.test');
    const headers = { Authorization: `Bearer ${adminToken}` };
    const created = await request(app).post('/api/courses').set(headers).send({
      title: 'Original Title',
      description: 'Desc',
      category: 'Foundations',
      level: 'beginner',
    });
    const originalSlug = created.body.course.slug as string;

    const updated = await request(app)
      .patch(`/api/courses/${created.body.course.id}`)
      .set(headers)
      .send({ title: 'Brand New Title' });

    expect(updated.status).toBe(200);
    expect(updated.body.course.title).toBe('Brand New Title');
    expect(updated.body.course.slug).toBe(originalSlug);
  });

  it('lessonCount sent by the client is ignored', async () => {
    const adminToken = await loginAs('super_admin', 'admin5@rva.test');
    const res = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Ignore Counters',
        description: 'Desc',
        category: 'Foundations',
        level: 'beginner',
        lessonCount: 99,
        totalDurationSec: 9999,
      });

    expect(res.status).toBe(201);
    expect(res.body.course.lessonCount).toBe(0);
    expect(res.body.course.totalDurationSec).toBe(0);
  });

  it('a course with no lessons cannot be published', async () => {
    const adminToken = await loginAs('super_admin', 'admin6@rva.test');
    const headers = { Authorization: `Bearer ${adminToken}` };
    const created = await request(app).post('/api/courses').set(headers).send({
      title: 'Empty Course',
      description: 'No lessons yet',
      category: 'Foundations',
      level: 'beginner',
    });

    const publish = await request(app)
      .patch(`/api/courses/${created.body.course.id}`)
      .set(headers)
      .send({ status: 'published' });

    expect(publish.status).toBe(400);
    expect(publish.body.error.code).toBe('VALIDATION_ERROR');
    expect(publish.body.error.message).toMatch(/zero lessons/i);
  });

  it('deleting a course that has progress archives it instead of removing it', async () => {
    const adminToken = await loginAs('super_admin', 'admin7@rva.test');
    const admin = await User.findOne({ email: 'admin7@rva.test' });
    const learner = await User.create({
      name: 'Learner',
      email: 'progress@rva.test',
      passwordHash: await argon2.hash('test-password-12', { type: argon2.argon2id }),
      role: 'user',
    });
    const course = await Course.create({
      title: 'With Progress',
      slug: 'with-progress',
      description: 'Has progress',
      category: 'Foundations',
      level: 'beginner',
      status: 'published',
      lessonCount: 1,
      createdBy: admin!._id,
    });
    await Progress.create({
      userId: learner._id,
      courseId: course._id,
      lessons: [],
    });

    const res = await request(app)
      .delete(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.course.status).toBe('archived');
    expect(res.body.message).toMatch(/archived/i);

    const stillThere = await Course.findById(course._id);
    expect(stillThere?.status).toBe('archived');
  });

  it('a non-https thumbnailUrl is rejected', async () => {
    const adminToken = await loginAs('super_admin', 'admin8@rva.test');
    const res = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Bad Thumb',
        description: 'Desc',
        category: 'Foundations',
        level: 'beginner',
        thumbnailUrl: 'http://insecure.example/thumb.jpg',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  describe('thumbnailPublicId storage cleanup', () => {
    const deleteMock = vi.fn<(key: string) => Promise<void>>();
    const adapter: StorageAdapter = {
      save: vi.fn(async () => ({ key: 'rva/thumbnails/new' })),
      delete: deleteMock,
      getPublicUrl: (key) => `https://res.cloudinary.com/demo/${key}`,
    };

    beforeEach(() => {
      deleteMock.mockReset();
      deleteMock.mockResolvedValue(undefined);
      setStorageAdapter(adapter);
    });

    afterEach(() => {
      resetStorageAdapterForTests();
    });

    it('replacing a Cloudinary thumbnail deletes the previous asset exactly once', async () => {
      const adminToken = await loginAs('super_admin', 'admin-thumb-replace@rva.test');
      const admin = await User.findOne({ email: 'admin-thumb-replace@rva.test' });
      const course = await Course.create({
        title: 'Cloudinary Thumb',
        slug: 'cloudinary-thumb',
        description: 'Has a stored asset',
        thumbnailUrl: 'https://res.cloudinary.com/demo/rva/thumbnails/old-id',
        thumbnailPublicId: 'rva/thumbnails/old-id',
        category: 'Foundations',
        level: 'beginner',
        status: 'draft',
        createdBy: admin!._id,
      });

      const res = await request(app)
        .patch(`/api/courses/${course._id.toString()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          thumbnailUrl: 'https://res.cloudinary.com/demo/rva/thumbnails/new-id',
          thumbnailPublicId: 'rva/thumbnails/new-id',
        });

      expect(res.status).toBe(200);
      expect(res.body.course.thumbnailUrl).toBe(
        'https://res.cloudinary.com/demo/rva/thumbnails/new-id',
      );
      expect(res.body.course.thumbnailPublicId).toBe('rva/thumbnails/new-id');
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith('rva/thumbnails/old-id');

      const stored = await Course.findById(course._id);
      expect(stored?.thumbnailPublicId).toBe('rva/thumbnails/new-id');
    });

    it('replacing an external https thumbnail deletes nothing', async () => {
      const adminToken = await loginAs('super_admin', 'admin-thumb-https@rva.test');
      const admin = await User.findOne({ email: 'admin-thumb-https@rva.test' });
      const course = await Course.create({
        title: 'External Thumb',
        slug: 'external-thumb',
        description: 'No stored asset',
        thumbnailUrl: 'https://cdn.example.com/old.jpg',
        thumbnailPublicId: null,
        category: 'Foundations',
        level: 'beginner',
        status: 'draft',
        createdBy: admin!._id,
      });

      const res = await request(app)
        .patch(`/api/courses/${course._id.toString()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          thumbnailUrl: 'https://cdn.example.com/new.jpg',
          thumbnailPublicId: null,
        });

      expect(res.status).toBe(200);
      expect(res.body.course.thumbnailUrl).toBe('https://cdn.example.com/new.jpg');
      expect(res.body.course.thumbnailPublicId).toBeNull();
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('a failing adapter delete does not fail or roll back the course update', async () => {
      deleteMock.mockRejectedValue(new Error('Cloudinary timeout'));
      const adminToken = await loginAs('super_admin', 'admin-thumb-fail@rva.test');
      const admin = await User.findOne({ email: 'admin-thumb-fail@rva.test' });
      const course = await Course.create({
        title: 'Failing Delete',
        slug: 'failing-delete',
        description: 'Delete will time out',
        thumbnailUrl: 'https://res.cloudinary.com/demo/rva/thumbnails/old-fail',
        thumbnailPublicId: 'rva/thumbnails/old-fail',
        category: 'Foundations',
        level: 'beginner',
        status: 'draft',
        createdBy: admin!._id,
      });

      const res = await request(app)
        .patch(`/api/courses/${course._id.toString()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          thumbnailUrl: 'https://res.cloudinary.com/demo/rva/thumbnails/new-fail',
          thumbnailPublicId: 'rva/thumbnails/new-fail',
        });

      expect(res.status).toBe(200);
      expect(res.body.course.thumbnailPublicId).toBe('rva/thumbnails/new-fail');
      expect(deleteMock).toHaveBeenCalledTimes(1);

      const stored = await Course.findById(course._id);
      expect(stored?.thumbnailUrl).toBe(
        'https://res.cloudinary.com/demo/rva/thumbnails/new-fail',
      );
      expect(stored?.thumbnailPublicId).toBe('rva/thumbnails/new-fail');
    });

    it('archiving keeps the asset; hard delete removes it', async () => {
      const adminToken = await loginAs('super_admin', 'admin-thumb-del@rva.test');
      const admin = await User.findOne({ email: 'admin-thumb-del@rva.test' });
      const learner = await User.create({
        name: 'Learner',
        email: 'thumb-progress@rva.test',
        passwordHash: await argon2.hash('test-password-12', { type: argon2.argon2id }),
        role: 'user',
      });

      const archivedCourse = await Course.create({
        title: 'Archive Keeps Image',
        slug: 'archive-keeps-image',
        description: 'Has progress',
        thumbnailUrl: 'https://res.cloudinary.com/demo/rva/thumbnails/keep-me',
        thumbnailPublicId: 'rva/thumbnails/keep-me',
        category: 'Foundations',
        level: 'beginner',
        status: 'published',
        lessonCount: 1,
        createdBy: admin!._id,
      });
      await Progress.create({
        userId: learner._id,
        courseId: archivedCourse._id,
        lessons: [],
      });

      const archiveRes = await request(app)
        .delete(`/api/courses/${archivedCourse._id.toString()}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.course.status).toBe('archived');
      expect(deleteMock).not.toHaveBeenCalled();
      const stillThere = await Course.findById(archivedCourse._id);
      expect(stillThere?.thumbnailPublicId).toBe('rva/thumbnails/keep-me');

      const hardDeleted = await Course.create({
        title: 'Hard Delete Image',
        slug: 'hard-delete-image',
        description: 'No progress',
        thumbnailUrl: 'https://res.cloudinary.com/demo/rva/thumbnails/remove-me',
        thumbnailPublicId: 'rva/thumbnails/remove-me',
        category: 'Foundations',
        level: 'beginner',
        status: 'draft',
        createdBy: admin!._id,
      });

      const hardRes = await request(app)
        .delete(`/api/courses/${hardDeleted._id.toString()}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(hardRes.status).toBe(204);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith('rva/thumbnails/remove-me');
      expect(await Course.findById(hardDeleted._id)).toBeNull();
    });

    it('thumbnailPublicId is never accepted from a learner-facing request', async () => {
      const adminToken = await loginAs('super_admin', 'admin-thumb-learner@rva.test');
      const admin = await User.findOne({ email: 'admin-thumb-learner@rva.test' });
      const course = await Course.create({
        title: 'Published With PublicId',
        slug: 'published-with-public-id',
        description: 'Visible to learners',
        thumbnailUrl: 'https://res.cloudinary.com/demo/rva/thumbnails/secret',
        thumbnailPublicId: 'rva/thumbnails/secret',
        category: 'Foundations',
        level: 'beginner',
        status: 'published',
        lessonCount: 1,
        createdBy: admin!._id,
      });

      const userToken = await loginAs('user', 'learner-thumb@rva.test');
      const headers = { Authorization: `Bearer ${userToken}` };

      const patch = await request(app)
        .patch(`/api/courses/${course._id.toString()}`)
        .set(headers)
        .send({
          thumbnailUrl: 'https://cdn.evil.example/owned.jpg',
          thumbnailPublicId: 'rva/thumbnails/hijacked',
        });
      expect(patch.status).toBe(403);
      expect(patch.body.error.code).toBe('FORBIDDEN');

      const create = await request(app).post('/api/courses').set(headers).send({
        title: 'Hijack',
        description: 'Nope',
        category: 'Foundations',
        level: 'beginner',
        thumbnailPublicId: 'rva/thumbnails/hijacked',
      });
      expect(create.body.error.code).toBe('FORBIDDEN');

      const list = await request(app).get('/api/courses').set(headers);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).not.toHaveProperty('thumbnailPublicId');

      const detail = await request(app)
        .get(`/api/courses/${course._id.toString()}`)
        .set(headers);
      expect(detail.status).toBe(200);
      expect(detail.body.course).not.toHaveProperty('thumbnailPublicId');
      expect(JSON.stringify(detail.body)).not.toMatch(/thumbnailPublicId/);

      const unchanged = await Course.findById(course._id);
      expect(unchanged?.thumbnailPublicId).toBe('rva/thumbnails/secret');
      expect(deleteMock).not.toHaveBeenCalled();

      const adminGet = await request(app)
        .get(`/api/courses/${course._id.toString()}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminGet.status).toBe(200);
      expect(adminGet.body.course.thumbnailPublicId).toBe('rva/thumbnails/secret');
    });
  });

  describe('Phase 11 course detail', () => {
  async function seedPublishedCourseWithLessons(opts?: {
    withFinalExam?: boolean;
    withLessonQuiz?: boolean;
  }) {
    const admin = await User.create({
      name: 'Admin',
      email: `admin-detail-${Date.now()}@rva.test`,
      passwordHash: await argon2.hash('test-password-12', { type: argon2.argon2id }),
      role: 'super_admin',
      mustChangePassword: false,
    });

    const course = await Course.create({
      title: 'Detail Course',
      slug: `detail-course-${Date.now()}`,
      description: 'Learner detail payload',
      category: 'Foundations',
      level: 'beginner',
      status: 'published',
      lessonCount: 2,
      totalDurationSec: 600,
      createdBy: admin._id,
    });

    const lessonA = await Lesson.create({
      courseId: course._id,
      title: 'Lesson One',
      description: 'First',
      youtubeVideoId: 'aaaaaaaaaaa',
      durationSec: 300,
      order: 1,
    });
    const lessonB = await Lesson.create({
      courseId: course._id,
      title: 'Lesson Two',
      description: 'Second',
      youtubeVideoId: 'bbbbbbbbbbb',
      durationSec: 300,
      order: 2,
    });

    if (opts?.withLessonQuiz) {
      await Quiz.create({
        scope: 'lesson',
        courseId: course._id,
        lessonId: lessonA._id,
        title: 'Lesson One Quiz',
        pointsPerQuestion: 2,
        questions: [
          {
            text: 'Secret Q?',
            options: ['A', 'B', 'C'],
            correctIndex: 1,
            order: 0,
          },
        ],
      });
    }

    if (opts?.withFinalExam) {
      await Quiz.create({
        scope: 'final_exam',
        courseId: course._id,
        lessonId: null,
        title: 'Final Exam',
        instructions: 'Submit a written response.',
        maxAttempts: null,
        questions: [
          {
            text: 'Exam Q?',
            options: [],
            order: 0,
          },
          {
            text: 'Exam Q2?',
            options: [],
            order: 1,
          },
        ],
      });
    }

    return { course, lessonA, lessonB, admin };
  }

  function assertNoQuizSecrets(payload: unknown) {
    const json = JSON.stringify(payload);
    expect(json).not.toMatch(/correctIndex/);
    expect(json).not.toMatch(/"questions"/);
    expect(json).not.toMatch(/"options"/);
  }

  it('the detail payload never contains correctIndex, questions, or options at any depth', async () => {
    const { course } = await seedPublishedCourseWithLessons({
      withFinalExam: true,
      withLessonQuiz: true,
    });
    const userToken = await loginAs('user', 'detail-secrets@rva.test');

    const res = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.lessons[0].hasQuiz).toBe(true);
    expect(res.body.lessons[0].quizMaxPoints).toBe(2);
    expect(res.body.finalExam).not.toBeNull();
    assertNoQuizSecrets(res.body);
  });

  it('a user with no progress gets nulls and zeros for every lesson, and the course still loads', async () => {
    const { course } = await seedPublishedCourseWithLessons({ withLessonQuiz: true });
    const userToken = await loginAs('user', 'detail-noprogress@rva.test');

    const res = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.course.title).toBe('Detail Course');
    expect(res.body.lessons).toHaveLength(2);
    for (const lesson of res.body.lessons) {
      expect(lesson.videoCompletedAt).toBeNull();
      expect(lesson.videoPointsAwarded).toBe(0);
      expect(lesson.bestQuizScore).toBeNull();
      expect(lesson.quizPointsAwarded).toBe(0);
      expect(lesson.quizAttempts).toBe(0);
    }
    expect(res.body.summary).toMatchObject({
      completedLessonCount: 0,
      progressPct: 0,
      totalPointsEarned: 0,
      lastLessonId: null,
    });
  });

  it("per-lesson progress reflects only the calling user's own data", async () => {
    const { course, lessonA } = await seedPublishedCourseWithLessons();
    const aliceToken = await loginAs('user', 'alice@rva.test');
    const bobToken = await loginAs('user', 'bob@rva.test');
    const alice = await User.findOne({ email: 'alice@rva.test' });
    const bob = await User.findOne({ email: 'bob@rva.test' });

    await Progress.create({
      userId: alice!._id,
      courseId: course._id,
      lastLessonId: lessonA._id,
      lessons: [
        {
          lessonId: lessonA._id,
          watchedSec: 300,
          videoCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });
    await Progress.create({
      userId: bob!._id,
      courseId: course._id,
      lessons: [
        {
          lessonId: lessonA._id,
          watchedSec: 10,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const aliceRes = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${aliceToken}`);
    const bobRes = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${bobToken}`);

    expect(aliceRes.body.lessons[0].videoCompletedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(aliceRes.body.lessons[0].videoPointsAwarded).toBe(5);
    expect(aliceRes.body.summary.completedLessonCount).toBe(1);
    expect(aliceRes.body.summary.lastLessonId).toBe(lessonA._id.toString());

    expect(bobRes.body.lessons[0].videoCompletedAt).toBeNull();
    expect(bobRes.body.lessons[0].videoPointsAwarded).toBe(0);
    expect(bobRes.body.summary.completedLessonCount).toBe(0);
    expect(bobRes.body.summary.lastLessonId).toBeNull();
  });

  it('finalExam.unlocked is false until every lesson video is complete', async () => {
    const { course, lessonA, lessonB } = await seedPublishedCourseWithLessons({
      withFinalExam: true,
    });
    const userToken = await loginAs('user', 'exam-unlock@rva.test');
    const user = await User.findOne({ email: 'exam-unlock@rva.test' });

    await Progress.create({
      userId: user!._id,
      courseId: course._id,
      lessons: [
        {
          lessonId: lessonA._id,
          watchedSec: 300,
          videoCompletedAt: new Date(),
          videoPointsAwarded: true,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const partial = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(partial.body.finalExam.exists).toBe(true);
    expect(partial.body.finalExam.unlocked).toBe(false);
    expect(partial.body.finalExam.maxMarks).toBe(50);
    expect(partial.body.finalExam.passMark).toBe(40);
    expect(partial.body.finalExam.submissionStatus).toBeNull();
    expect(partial.body.summary.completedLessonCount).toBe(1);

    await Progress.updateOne(
      { userId: user!._id, courseId: course._id },
      {
        $push: {
          lessons: {
            lessonId: lessonB._id,
            watchedSec: 300,
            videoCompletedAt: new Date(),
            videoPointsAwarded: true,
            bestQuizScore: 0,
            quizPointsAwarded: 0,
            attempts: 0,
          },
        },
      },
    );

    const complete = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(complete.body.finalExam.unlocked).toBe(true);
    expect(complete.body.summary.completedLessonCount).toBe(2);
  });

  it('finalExam is null when the course has no final exam', async () => {
    const { course } = await seedPublishedCourseWithLessons({ withFinalExam: false });
    const userToken = await loginAs('user', 'no-exam@rva.test');

    const res = await request(app)
      .get(`/api/courses/${course._id.toString()}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.finalExam).toBeNull();
  });

  it("a draft course returns NOT_FOUND for a 'user' and loads for a super_admin", async () => {
    const adminToken = await loginAs('super_admin', 'draft-admin@rva.test');
    const admin = await User.findOne({ email: 'draft-admin@rva.test' });
    const draft = await Course.create({
      title: 'Draft Detail',
      slug: 'draft-detail',
      description: 'Hidden',
      category: 'Ops',
      level: 'beginner',
      status: 'draft',
      lessonCount: 0,
      createdBy: admin!._id,
    });
    const userToken = await loginAs('user', 'draft-user@rva.test');

    const userRes = await request(app)
      .get(`/api/courses/${draft._id.toString()}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(userRes.status).toBe(404);
    expect(userRes.body.error.code).toBe('NOT_FOUND');

    const adminRes = await request(app)
      .get(`/api/courses/${draft._id.toString()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.course.title).toBe('Draft Detail');
    expect(adminRes.body.lessons).toBeUndefined();
  });
  });
});
