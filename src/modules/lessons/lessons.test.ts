import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../../shared/index.js';
import { createApp } from '../../app.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { Quiz } from '../../models/Quiz.js';
import { User } from '../../models/User.js';
import { parseYouTubeVideoId } from '../../utils/youtube.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

describe('Phase 7B lessons', () => {
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
      Lesson.deleteMany({}),
      Quiz.deleteMany({}),
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

  async function createDraftCourse(adminToken: string) {
    const res = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Lesson Course',
        description: 'For lesson tests',
        category: 'Foundations',
        level: 'beginner',
      });
    return res.body.course as { id: string };
  }

  it('a bare id, a watch?v= URL, a youtu.be URL and a /shorts/ URL all resolve to the same id', () => {
    expect(parseYouTubeVideoId(VIDEO_ID)).toBe(VIDEO_ID);
    expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${VIDEO_ID}`)).toBe(
      VIDEO_ID,
    );
    expect(parseYouTubeVideoId(`https://youtu.be/${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${VIDEO_ID}`)).toBe(
      VIDEO_ID,
    );
  });

  it('a non-YouTube URL is rejected', async () => {
    const adminToken = await loginAs('super_admin', 'admin-yt@rva.test');
    const course = await createDraftCourse(adminToken);

    const res = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Bad video',
        description: 'Nope',
        youtubeVideoId: 'https://vimeo.com/123456789',
        durationSec: 100,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requiredWatchSec defaults to 90% of durationSec when omitted', async () => {
    const adminToken = await loginAs('super_admin', 'admin-watch-default@rva.test');
    const course = await createDraftCourse(adminToken);
    const durationSec = 100;

    const res = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Watch threshold',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec,
      });

    expect(res.status).toBe(201);
    expect(res.body.lesson.requiredWatchSec).toBe(
      Math.ceil(durationSec * RULES.VIDEO_COMPLETION_RATIO),
    );
    expect(res.body.lesson.requiredWatchSec).toBe(90);
    expect(res.body.lesson.watchTargetOverridden).toBe(false);
  });

  it('admin can set requiredWatchSec on create and update', async () => {
    const adminToken = await loginAs('super_admin', 'admin-watch-override@rva.test');
    const course = await createDraftCourse(adminToken);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const created = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Custom watch',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec: 100,
        requiredWatchSec: 45,
      });

    expect(created.status).toBe(201);
    expect(created.body.lesson.requiredWatchSec).toBe(45);
    expect(created.body.lesson.watchTargetOverridden).toBe(true);

    const updated = await request(app)
      .patch(`/api/lessons/${created.body.lesson.id}`)
      .set(headers)
      .send({ requiredWatchSec: 30 });

    expect(updated.status).toBe(200);
    expect(updated.body.lesson.requiredWatchSec).toBe(30);
    expect(updated.body.lesson.watchTargetOverridden).toBe(true);
  });

  it('rejects requiredWatchSec greater than durationSec with both numbers in the message', async () => {
    const adminToken = await loginAs('super_admin', 'admin-watch-gt@rva.test');
    const course = await createDraftCourse(adminToken);

    const res = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Impossible target',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec: 60,
        requiredWatchSec: 90,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/requiredWatchSec \(90\)/);
    expect(res.body.error.message).toMatch(/durationSec \(60\)/);
  });

  it('recomputes requiredWatchSec when durationSec changes and target was not overridden', async () => {
    const adminToken = await loginAs('super_admin', 'admin-watch-recompute@rva.test');
    const course = await createDraftCourse(adminToken);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const created = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Auto target',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec: 100,
      });

    expect(created.body.lesson.requiredWatchSec).toBe(90);
    expect(created.body.lesson.watchTargetOverridden).toBe(false);

    const updated = await request(app)
      .patch(`/api/lessons/${created.body.lesson.id}`)
      .set(headers)
      .send({ durationSec: 200 });

    expect(updated.status).toBe(200);
    expect(updated.body.lesson.requiredWatchSec).toBe(180);
    expect(updated.body.lesson.watchTargetOverridden).toBe(false);
    expect(updated.body.lesson.warning).toBeUndefined();
  });

  it('leaves an overridden requiredWatchSec alone when durationSec changes and returns a warning', async () => {
    const adminToken = await loginAs('super_admin', 'admin-watch-warn@rva.test');
    const course = await createDraftCourse(adminToken);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const created = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Override keep',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec: 100,
        requiredWatchSec: 40,
      });

    const updated = await request(app)
      .patch(`/api/lessons/${created.body.lesson.id}`)
      .set(headers)
      .send({ durationSec: 200 });

    expect(updated.status).toBe(200);
    expect(updated.body.lesson.requiredWatchSec).toBe(40);
    expect(updated.body.lesson.watchTargetOverridden).toBe(true);
    expect(updated.body.lesson.warning).toMatch(/40/);
    expect(updated.body.lesson.warning).toMatch(/200/);
  });

  it('learner-supplied requiredWatchSec on heartbeat and complete-video is ignored; the DB value is used', async () => {
    const adminToken = await loginAs('super_admin', 'admin-watch-secure@rva.test');
    const course = await createDraftCourse(adminToken);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const created = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Secure watch',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec: 100,
        requiredWatchSec: 50,
      });
    const lessonId = created.body.lesson.id as string;
    expect(created.body.lesson.requiredWatchSec).toBe(50);

    await request(app)
      .patch(`/api/courses/${course.id}`)
      .set(headers)
      .send({ status: 'published' });

    const userToken = await loginAs('user', 'learner-watch-secure@rva.test');
    const userHeaders = { Authorization: `Bearer ${userToken}` };

    const heartbeat = await request(app)
      .post(`/api/lessons/${lessonId}/heartbeat`)
      .set(userHeaders)
      .send({
        deltaSec: 10,
        playerPositionSec: 10,
        requiredWatchSec: 1,
      });
    expect(heartbeat.status).toBe(200);

    const lessonAfterHb = await Lesson.findById(lessonId);
    expect(lessonAfterHb?.requiredWatchSec).toBe(50);

    const earlyComplete = await request(app)
      .post(`/api/lessons/${lessonId}/complete-video`)
      .set(userHeaders)
      .send({ requiredWatchSec: 1 });
    expect(earlyComplete.status).toBe(400);
    expect(earlyComplete.body.error.code).toBe('VALIDATION_ERROR');

    const learner = await User.findOne({ email: 'learner-watch-secure@rva.test' });
    await Progress.updateOne(
      { userId: learner!._id, courseId: course.id },
      { $set: { 'lessons.0.watchedSec': 50 } },
    );

    const complete = await request(app)
      .post(`/api/lessons/${lessonId}/complete-video`)
      .set(userHeaders)
      .send({ requiredWatchSec: 1 });
    expect(complete.status).toBe(200);

    const lessonFinal = await Lesson.findById(lessonId);
    expect(lessonFinal?.requiredWatchSec).toBe(50);
  });

  it('new lessons get order 10, 20, 30', async () => {
    const adminToken = await loginAs('super_admin', 'admin-order@rva.test');
    const course = await createDraftCourse(adminToken);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const a = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'First',
        description: 'A',
        youtubeVideoId: VIDEO_ID,
        durationSec: 60,
      });
    const b = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Second',
        description: 'B',
        youtubeVideoId: `https://youtu.be/${VIDEO_ID}`,
        durationSec: 60,
      });
    const c = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Third',
        description: 'C',
        youtubeVideoId: VIDEO_ID,
        durationSec: 60,
      });

    expect(a.body.lesson.order).toBe(10);
    expect(b.body.lesson.order).toBe(20);
    expect(c.body.lesson.order).toBe(30);
  });

  it('reorder rewrites the sequence correctly and is rejected on a missing or duplicate id', async () => {
    const adminToken = await loginAs('super_admin', 'admin-reorder@rva.test');
    const course = await createDraftCourse(adminToken);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const created = [];
    for (const title of ['A', 'B', 'C']) {
      const res = await request(app)
        .post(`/api/courses/${course.id}/lessons`)
        .set(headers)
        .send({
          title,
          description: title,
          youtubeVideoId: VIDEO_ID,
          durationSec: 50,
        });
      created.push(res.body.lesson);
    }

    const ids = created.map((l: { id: string }) => l.id);
    const reversed = [...ids].reverse();

    const ok = await request(app)
      .patch(`/api/courses/${course.id}/lessons/reorder`)
      .set(headers)
      .send({ lessonIds: reversed });

    expect(ok.status).toBe(200);
    expect(ok.body.lessons.map((l: { id: string }) => l.id)).toEqual(reversed);
    expect(ok.body.lessons.map((l: { order: number }) => l.order)).toEqual([
      10, 20, 30,
    ]);

    const missing = await request(app)
      .patch(`/api/courses/${course.id}/lessons/reorder`)
      .set(headers)
      .send({ lessonIds: [ids[0], ids[1]] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    const duplicate = await request(app)
      .patch(`/api/courses/${course.id}/lessons/reorder`)
      .set(headers)
      .send({ lessonIds: [ids[0], ids[0], ids[1]] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('deleting a lesson deletes its quiz and prunes it from Progress documents', async () => {
    const adminToken = await loginAs('super_admin', 'admin-cascade@rva.test');
    const course = await createDraftCourse(adminToken);
    const headers = { Authorization: `Bearer ${adminToken}` };

    const first = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Keep',
        description: 'Stay',
        youtubeVideoId: VIDEO_ID,
        durationSec: 40,
      });
    const target = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Remove',
        description: 'Gone',
        youtubeVideoId: VIDEO_ID,
        durationSec: 40,
      });

    const lessonId = target.body.lesson.id as string;
    await Quiz.create({
      scope: 'lesson',
      courseId: course.id,
      lessonId,
      title: 'Quiz',
      questions: [
        {
          text: 'Q1',
          options: ['A', 'B'],
          correctIndex: 0,
          order: 1,
        },
      ],
    });

    const learner = await User.create({
      name: 'Learner',
      email: 'cascade-learner@rva.test',
      passwordHash: await argon2.hash('test-password-12', { type: argon2.argon2id }),
      role: 'user',
    });
    await Progress.create({
      userId: learner._id,
      courseId: course.id,
      lessons: [
        {
          lessonId: first.body.lesson.id,
          watchedSec: 10,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
        {
          lessonId,
          watchedSec: 5,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
      lastLessonId: lessonId,
    });

    const del = await request(app)
      .delete(`/api/lessons/${lessonId}`)
      .set(headers);

    expect(del.status).toBe(204);
    expect(await Quiz.findOne({ lessonId })).toBeNull();

    const progress = await Progress.findOne({ userId: learner._id });
    expect(progress?.lessons).toHaveLength(1);
    expect(progress?.lessons[0]?.lessonId.toString()).toBe(first.body.lesson.id);
    expect(progress?.lastLessonId).toBeUndefined();
  });

  it('deleting the last lesson of a published course is refused', async () => {
    const adminToken = await loginAs('super_admin', 'admin-last@rva.test');
    const headers = { Authorization: `Bearer ${adminToken}` };
    const course = await createDraftCourse(adminToken);

    const lesson = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Only lesson',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec: 30,
      });

    await Course.findByIdAndUpdate(course.id, { status: 'published' });

    const del = await request(app)
      .delete(`/api/lessons/${lesson.body.lesson.id}`)
      .set(headers);

    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe('VALIDATION_ERROR');
    expect(del.body.error.message).toMatch(/unpublish/i);
    expect(await Lesson.countDocuments({ courseId: course.id })).toBe(1);
  });

  it('lessonCount and totalDurationSec stay correct after create, delete and reorder', async () => {
    const adminToken = await loginAs('super_admin', 'admin-stats@rva.test');
    const headers = { Authorization: `Bearer ${adminToken}` };
    const course = await createDraftCourse(adminToken);

    const a = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'A',
        description: 'A',
        youtubeVideoId: VIDEO_ID,
        durationSec: 100,
      });
    const b = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'B',
        description: 'B',
        youtubeVideoId: VIDEO_ID,
        durationSec: 50,
      });

    let fresh = await Course.findById(course.id);
    expect(fresh?.lessonCount).toBe(2);
    expect(fresh?.totalDurationSec).toBe(150);

    await request(app)
      .patch(`/api/courses/${course.id}/lessons/reorder`)
      .set(headers)
      .send({ lessonIds: [b.body.lesson.id, a.body.lesson.id] });

    fresh = await Course.findById(course.id);
    expect(fresh?.lessonCount).toBe(2);
    expect(fresh?.totalDurationSec).toBe(150);

    await request(app).delete(`/api/lessons/${a.body.lesson.id}`).set(headers);

    fresh = await Course.findById(course.id);
    expect(fresh?.lessonCount).toBe(1);
    expect(fresh?.totalDurationSec).toBe(50);
  });

  it("a 'user' role gets FORBIDDEN on create, patch, delete and reorder", async () => {
    const adminToken = await loginAs('super_admin', 'admin-forbid@rva.test');
    const course = await createDraftCourse(adminToken);
    const lesson = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Locked',
        description: 'Desc',
        youtubeVideoId: VIDEO_ID,
        durationSec: 20,
      });

    const userToken = await loginAs('user', 'learner-forbid@rva.test');
    const headers = { Authorization: `Bearer ${userToken}` };

    const create = await request(app)
      .post(`/api/courses/${course.id}/lessons`)
      .set(headers)
      .send({
        title: 'Nope',
        description: 'Nope',
        youtubeVideoId: VIDEO_ID,
        durationSec: 20,
      });
    const patch = await request(app)
      .patch(`/api/lessons/${lesson.body.lesson.id}`)
      .set(headers)
      .send({ title: 'Nope' });
    const del = await request(app)
      .delete(`/api/lessons/${lesson.body.lesson.id}`)
      .set(headers);
    const reorder = await request(app)
      .patch(`/api/courses/${course.id}/lessons/reorder`)
      .set(headers)
      .send({ lessonIds: [lesson.body.lesson.id] });

    expect(create.body.error.code).toBe('FORBIDDEN');
    expect(patch.body.error.code).toBe('FORBIDDEN');
    expect(del.body.error.code).toBe('FORBIDDEN');
    expect(reorder.body.error.code).toBe('FORBIDDEN');
  });

  describe('Phase 12 learning lesson detail', () => {
    async function seedPublishedCourseWithLessons(count: number) {
      const adminToken = await loginAs(
        'super_admin',
        `admin-learn-${Date.now()}@rva.test`,
      );
      const course = await createDraftCourse(adminToken);
      const lessonIds: string[] = [];

      for (let i = 0; i < count; i += 1) {
        const res = await request(app)
          .post(`/api/courses/${course.id}/lessons`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            title: `Lesson ${i + 1}`,
            description: `Description for lesson ${i + 1}`,
            youtubeVideoId: VIDEO_ID,
            durationSec: 100 + i,
          });
        lessonIds.push(res.body.lesson.id as string);
      }

      await request(app)
        .patch(`/api/courses/${course.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'published' });

      return { adminToken, courseId: course.id, lessonIds };
    }

    it('the payload never contains correctIndex, options, or question text at any depth', async () => {
      const { adminToken, courseId, lessonIds } =
        await seedPublishedCourseWithLessons(1);
      const lessonId = lessonIds[0]!;
      const secretText = 'UNIQUE_SECRET_QUESTION_TEXT_XYZ';

      await request(app)
        .put(`/api/lessons/${lessonId}/quiz`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Lesson Quiz',
          pointsPerQuestion: 2,
          passingScorePct: 70,
          questions: [
            {
              text: secretText,
              options: ['AlphaOpt', 'BetaOpt', 'GammaOpt'],
              correctIndex: 1,
            },
          ],
        });

      const userToken = await loginAs('user', 'learn-secrets@rva.test');
      const res = await request(app)
        .get(`/api/lessons/${lessonId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.quiz).toMatchObject({
        exists: true,
        title: 'Lesson Quiz',
        questionCount: 1,
        maxPoints: 2,
      });
      expect(res.body.lesson.courseId).toBe(courseId);

      const json = JSON.stringify(res.body);
      expect(json).not.toMatch(/correctIndex/);
      expect(json).not.toMatch(/"options"/);
      expect(json).not.toContain(secretText);
      expect(json).not.toContain('AlphaOpt');
    });

    it('prevLessonId and nextLessonId are correct at both ends of the course', async () => {
      const { lessonIds } = await seedPublishedCourseWithLessons(3);
      const [first, middle, last] = lessonIds;
      const userToken = await loginAs('user', 'learn-nav@rva.test');

      const firstRes = await request(app)
        .get(`/api/lessons/${first}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(firstRes.body.courseNav.prevLessonId).toBeNull();
      expect(firstRes.body.courseNav.nextLessonId).toBe(middle);
      expect(firstRes.body.courseNav.lessons).toHaveLength(3);

      const midRes = await request(app)
        .get(`/api/lessons/${middle}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(midRes.body.courseNav.prevLessonId).toBe(first);
      expect(midRes.body.courseNav.nextLessonId).toBe(last);

      const lastRes = await request(app)
        .get(`/api/lessons/${last}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(lastRes.body.courseNav.prevLessonId).toBe(middle);
      expect(lastRes.body.courseNav.nextLessonId).toBeNull();
    });

    it("a lesson in a draft course returns NOT_FOUND for a 'user'", async () => {
      const adminToken = await loginAs('super_admin', 'draft-lesson-admin@rva.test');
      const course = await createDraftCourse(adminToken);
      const lesson = await request(app)
        .post(`/api/courses/${course.id}/lessons`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Draft lesson',
          description: 'Hidden',
          youtubeVideoId: VIDEO_ID,
          durationSec: 60,
        });

      const userToken = await loginAs('user', 'draft-lesson-user@rva.test');
      const res = await request(app)
        .get(`/api/lessons/${lesson.body.lesson.id}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it("progress reflects only the calling user's own data", async () => {
      const { courseId, lessonIds } = await seedPublishedCourseWithLessons(1);
      const lessonId = lessonIds[0]!;
      const aliceToken = await loginAs('user', 'alice-learn@rva.test');
      const bobToken = await loginAs('user', 'bob-learn@rva.test');
      const alice = await User.findOne({ email: 'alice-learn@rva.test' });
      const bob = await User.findOne({ email: 'bob-learn@rva.test' });

      await Progress.create({
        userId: alice!._id,
        courseId,
        lessons: [
          {
            lessonId,
            watchedSec: 77,
            videoCompletedAt: new Date('2026-02-01T00:00:00.000Z'),
            videoPointsAwarded: true,
            bestQuizScore: 4,
            quizPointsAwarded: 4,
            attempts: 2,
          },
        ],
      });
      await Progress.create({
        userId: bob!._id,
        courseId,
        lessons: [
          {
            lessonId,
            watchedSec: 3,
            videoPointsAwarded: false,
            bestQuizScore: 0,
            quizPointsAwarded: 0,
            attempts: 0,
          },
        ],
      });

      const aliceRes = await request(app)
        .get(`/api/lessons/${lessonId}`)
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(aliceRes.body.progress).toMatchObject({
        watchedSec: 77,
        videoCompletedAt: '2026-02-01T00:00:00.000Z',
        videoPointsAwarded: 5,
        bestQuizScore: 4,
        quizPointsAwarded: 4,
        quizAttempts: 2,
      });

      const bobRes = await request(app)
        .get(`/api/lessons/${lessonId}`)
        .set('Authorization', `Bearer ${bobToken}`);
      expect(bobRes.body.progress).toMatchObject({
        watchedSec: 3,
        videoCompletedAt: null,
        videoPointsAwarded: 0,
        bestQuizScore: null,
        quizPointsAwarded: 0,
        quizAttempts: 0,
      });
    });
  });
});
