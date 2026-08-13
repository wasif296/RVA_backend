import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '@shared';
import { createApp } from '../../app.js';
import { Course } from '../../models/Course.js';
import { Lesson } from '../../models/Lesson.js';
import { Progress } from '../../models/Progress.js';
import { User } from '../../models/User.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

describe('Phase 13 watch timer / heartbeat', () => {
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

  async function seedPublishedLesson(opts?: { durationSec?: number }) {
    const durationSec = opts?.durationSec ?? 100;
    const adminToken = await loginAs(
      'super_admin',
      `admin-watch-${Date.now()}@rva.test`,
    );
    const courseRes = await request(app)
      .post('/api/courses')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Watch Course',
        description: 'For watch tests',
        category: 'Foundations',
        level: 'beginner',
      });
    const courseId = courseRes.body.course.id as string;

    const lessonRes = await request(app)
      .post(`/api/courses/${courseId}/lessons`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Watch Lesson',
        description: 'A lesson',
        youtubeVideoId: VIDEO_ID,
        durationSec,
      });

    await request(app)
      .patch(`/api/courses/${courseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'published' });

    const lesson = await Lesson.findById(lessonRes.body.lesson.id);
    return {
      adminToken,
      courseId,
      lessonId: lessonRes.body.lesson.id as string,
      durationSec,
      requiredWatchSec: lesson!.requiredWatchSec,
    };
  }

  async function heartbeat(
    token: string,
    lessonId: string,
    body: { deltaSec: number; playerPositionSec?: number },
  ) {
    return request(app)
      .post(`/api/lessons/${lessonId}/heartbeat`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        deltaSec: body.deltaSec,
        playerPositionSec: body.playerPositionSec ?? 0,
      });
  }

  it('deltaSec above 20 is rejected', async () => {
    const { lessonId } = await seedPublishedLesson();
    const token = await loginAs('user', 'delta-high@rva.test');

    const res = await heartbeat(token, lessonId, { deltaSec: 21 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HEARTBEAT_REJECTED');
  });

  it('a second heartbeat within 12 seconds is rejected', async () => {
    const { lessonId } = await seedPublishedLesson();
    const token = await loginAs('user', 'gap@rva.test');

    const first = await heartbeat(token, lessonId, { deltaSec: 5 });
    expect(first.status).toBe(200);

    const second = await heartbeat(token, lessonId, { deltaSec: 5 });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('HEARTBEAT_REJECTED');
  });

  it('watchedSec cannot exceed durationSec * 1.5', async () => {
    const { lessonId, durationSec } = await seedPublishedLesson({
      durationSec: 40,
    });
    const token = await loginAs('user', 'cap@rva.test');
    const user = await User.findOne({ email: 'cap@rva.test' });

    const first = await heartbeat(token, lessonId, { deltaSec: 20 });
    expect(first.status).toBe(200);

    await Progress.updateOne(
      { userId: user!._id },
      {
        $set: {
          'lessons.0.lastHeartbeatAt': new Date(Date.now() - 13_000),
          'lessons.0.firstHeartbeatAt': new Date(Date.now() - 200_000),
          'lessons.0.watchedSec': durationSec * 1.5 - 5,
        },
      },
    );

    const res = await heartbeat(token, lessonId, { deltaSec: 20 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HEARTBEAT_REJECTED');
  });

  it('accumulated watchedSec exceeding real elapsed time is rejected', async () => {
    const { lessonId } = await seedPublishedLesson({ durationSec: 400 });
    const token = await loginAs('user', 'elapsed@rva.test');
    const user = await User.findOne({ email: 'elapsed@rva.test' });

    const first = await heartbeat(token, lessonId, { deltaSec: 1 });
    expect(first.status).toBe(200);

    // Genuinely impossible: ~300s of watch inside ~30s of wall time (tolerance is 20s).
    await Progress.updateOne(
      { userId: user!._id },
      {
        $set: {
          'lessons.0.lastHeartbeatAt': new Date(Date.now() - 13_000),
          'lessons.0.firstHeartbeatAt': new Date(Date.now() - 30_000),
          'lessons.0.watchedSec': 280,
        },
      },
    );

    const res = await heartbeat(token, lessonId, { deltaSec: 20 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HEARTBEAT_REJECTED');
    expect(res.body.error.message).toMatch(/elapsed time/i);
  });

  it('a continuous watch session sends many consecutive heartbeats with none rejected', async () => {
    const { lessonId } = await seedPublishedLesson({ durationSec: 400 });
    const token = await loginAs('user', 'continuous@rva.test');
    const user = await User.findOne({ email: 'continuous@rva.test' });

    // Stay under the 6/min heartbeat rate limit while still proving a multi-pulse session.
    // Simulate client cadence: 15s delta with ~13s wall between pulses.
    for (let i = 1; i <= 5; i += 1) {
      if (i > 1) {
        await Progress.updateOne(
          { userId: user!._id },
          {
            $set: {
              'lessons.0.lastHeartbeatAt': new Date(Date.now() - 13_000),
              'lessons.0.firstHeartbeatAt': new Date(Date.now() - i * 15_000),
            },
          },
        );
      }

      const res = await heartbeat(token, lessonId, {
        deltaSec: 15,
        playerPositionSec: i * 15,
      });
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.progress.watchedSec).toBe(i * 15);
    }
  });

  it('a single wall-clock rejection does not corrupt state; a later honest heartbeat succeeds', async () => {
    const { lessonId } = await seedPublishedLesson({ durationSec: 400 });
    const token = await loginAs('user', 'retry-hb@rva.test');
    const user = await User.findOne({ email: 'retry-hb@rva.test' });

    const first = await heartbeat(token, lessonId, { deltaSec: 15 });
    expect(first.status).toBe(200);

    // Impossible claim even with the 20s tolerance (300s watch in ~30s wall).
    await Progress.updateOne(
      { userId: user!._id },
      {
        $set: {
          'lessons.0.lastHeartbeatAt': new Date(Date.now() - 13_000),
          'lessons.0.firstHeartbeatAt': new Date(Date.now() - 30_000),
          'lessons.0.watchedSec': 280,
        },
      },
    );

    const rejected = await heartbeat(token, lessonId, { deltaSec: 20 });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('HEARTBEAT_REJECTED');

    const mid = await Progress.findOne({ userId: user!._id });
    expect(mid!.lessons[0]!.watchedSec).toBe(280);

    // Retry with honest elapsed covering the next delta.
    await Progress.updateOne(
      { userId: user!._id },
      {
        $set: {
          'lessons.0.lastHeartbeatAt': new Date(Date.now() - 13_000),
          'lessons.0.firstHeartbeatAt': new Date(Date.now() - 320_000),
          'lessons.0.watchedSec': 15,
        },
      },
    );

    const recovered = await heartbeat(token, lessonId, { deltaSec: 15 });
    expect(recovered.status).toBe(200);
    expect(recovered.body.progress.watchedSec).toBe(30);
  });

  it('the first heartbeat creates the Progress document and its lesson entry', async () => {
    const { lessonId, courseId } = await seedPublishedLesson();
    const token = await loginAs('user', 'create-progress@rva.test');
    const user = await User.findOne({ email: 'create-progress@rva.test' });

    expect(await Progress.countDocuments({})).toBe(0);

    const res = await heartbeat(token, lessonId, { deltaSec: 8 });
    expect(res.status).toBe(200);
    expect(res.body.progress.watchedSec).toBe(8);

    const progress = await Progress.findOne({
      userId: user!._id,
      courseId,
    });
    expect(progress).toBeTruthy();
    expect(progress!.startedAt).toBeTruthy();
    expect(progress!.lastLessonId?.toString()).toBe(lessonId);
    expect(progress!.lessons).toHaveLength(1);
    expect(progress!.lessons[0]!.lessonId.toString()).toBe(lessonId);
    expect(progress!.lessons[0]!.watchedSec).toBe(8);
    expect(progress!.lessons[0]!.firstHeartbeatAt).toBeTruthy();
  });

  it('a final small heartbeat that crosses requiredWatchSec awards points without a refresh', async () => {
    const { lessonId, requiredWatchSec } = await seedPublishedLesson({
      durationSec: 40,
    });
    const token = await loginAs('user', 'final-seconds@rva.test');
    const user = await User.findOne({ email: 'final-seconds@rva.test' });

    expect(requiredWatchSec).toBe(36);

    const first = await heartbeat(token, lessonId, { deltaSec: 20 });
    expect(first.status).toBe(200);

    // Simulate near end-of-video: almost at the target, then a trailing flush
    // of the last accrued seconds (the client ENDED path).
    await Progress.updateOne(
      { userId: user!._id },
      {
        $set: {
          'lessons.0.lastHeartbeatAt': new Date(Date.now() - 13_000),
          'lessons.0.firstHeartbeatAt': new Date(Date.now() - 180_000),
          'lessons.0.watchedSec': requiredWatchSec - 8,
        },
      },
    );

    const finalFlush = await heartbeat(token, lessonId, {
      deltaSec: 10,
      playerPositionSec: 40,
    });
    expect(finalFlush.status).toBe(200);
    expect(finalFlush.body.progress.watchedSec).toBeGreaterThanOrEqual(
      requiredWatchSec,
    );
    expect(finalFlush.body.progress.videoPointsAwarded).toBe(RULES.VIDEO_POINTS);
    expect(finalFlush.body.completed).toBe(true);
    expect(finalFlush.body.pointsAwarded).toBe(RULES.VIDEO_POINTS);

    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(RULES.VIDEO_POINTS);
  });

  it('reaching requiredWatchSec awards exactly 5 points', async () => {
    const { lessonId, requiredWatchSec } = await seedPublishedLesson({
      durationSec: 20,
    });
    const token = await loginAs('user', 'award@rva.test');
    const user = await User.findOne({ email: 'award@rva.test' });

    expect(requiredWatchSec).toBe(18);

    const first = await heartbeat(token, lessonId, { deltaSec: 10 });
    expect(first.status).toBe(200);

    await Progress.updateOne(
      { userId: user!._id },
      {
        $set: {
          'lessons.0.lastHeartbeatAt': new Date(Date.now() - 13_000),
          'lessons.0.firstHeartbeatAt': new Date(Date.now() - 120_000),
        },
      },
    );

    const res = await heartbeat(token, lessonId, { deltaSec: 8 });
    expect(res.status).toBe(200);
    expect(res.body.progress.watchedSec).toBe(18);
    expect(res.body.progress.videoPointsAwarded).toBe(RULES.VIDEO_POINTS);
    expect(res.body.completed).toBe(true);
    expect(res.body.pointsAwarded).toBe(RULES.VIDEO_POINTS);

    const refreshedUser = await User.findById(user!._id);
    expect(refreshedUser!.totalPoints).toBe(RULES.VIDEO_POINTS);
  });

  it('calling complete-video twice awards 5 points once, and the second call returns 200', async () => {
    const { lessonId, requiredWatchSec, courseId } = await seedPublishedLesson({
      durationSec: 20,
    });
    const token = await loginAs('user', 'idempotent@rva.test');
    const user = await User.findOne({ email: 'idempotent@rva.test' });

    await Progress.create({
      userId: user!._id,
      courseId,
      startedAt: new Date(),
      lessons: [
        {
          lessonId,
          watchedSec: requiredWatchSec,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
          firstHeartbeatAt: new Date(Date.now() - 120_000),
          lastHeartbeatAt: new Date(Date.now() - 13_000),
        },
      ],
    });

    const first = await request(app)
      .post(`/api/lessons/${lessonId}/complete-video`)
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .post(`/api/lessons/${lessonId}/complete-video`)
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    expect(first.body.pointsAwarded).toBe(RULES.VIDEO_POINTS);
    expect(second.status).toBe(200);
    expect(second.body.pointsAwarded).toBe(0);
    expect(second.body.progress.videoPointsAwarded).toBe(RULES.VIDEO_POINTS);

    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(RULES.VIDEO_POINTS);
  });

  it('ten concurrent complete-video calls award 5 points exactly once', async () => {
    const { lessonId, requiredWatchSec, courseId } = await seedPublishedLesson({
      durationSec: 20,
    });
    const token = await loginAs('user', 'concurrent@rva.test');
    const user = await User.findOne({ email: 'concurrent@rva.test' });

    await Progress.create({
      userId: user!._id,
      courseId,
      startedAt: new Date(),
      lessons: [
        {
          lessonId,
          watchedSec: requiredWatchSec,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
          firstHeartbeatAt: new Date(Date.now() - 120_000),
          lastHeartbeatAt: new Date(Date.now() - 13_000),
        },
      ],
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post(`/api/lessons/${lessonId}/complete-video`)
          .set('Authorization', `Bearer ${token}`),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const awarded = results.filter((r) => r.body.pointsAwarded === RULES.VIDEO_POINTS);
    expect(awarded).toHaveLength(1);

    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(RULES.VIDEO_POINTS);
  });

  it('complete-video before requiredWatchSec is rejected', async () => {
    const { lessonId, courseId, requiredWatchSec } = await seedPublishedLesson({
      durationSec: 100,
    });
    const token = await loginAs('user', 'early@rva.test');
    const user = await User.findOne({ email: 'early@rva.test' });

    await Progress.create({
      userId: user!._id,
      courseId,
      lessons: [
        {
          lessonId,
          watchedSec: Math.max(1, requiredWatchSec - 10),
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    const res = await request(app)
      .post(`/api/lessons/${lessonId}/complete-video`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(0);
  });

  it('User.totalPoints matches the sum of awarded points', async () => {
    const { lessonId, requiredWatchSec, courseId } = await seedPublishedLesson({
      durationSec: 20,
    });
    const token = await loginAs('user', 'total-pts@rva.test');
    const user = await User.findOne({ email: 'total-pts@rva.test' });

    await Progress.create({
      userId: user!._id,
      courseId,
      lessons: [
        {
          lessonId,
          watchedSec: requiredWatchSec,
          videoPointsAwarded: false,
          bestQuizScore: 0,
          quizPointsAwarded: 0,
          attempts: 0,
        },
      ],
    });

    await request(app)
      .post(`/api/lessons/${lessonId}/complete-video`)
      .set('Authorization', `Bearer ${token}`);

    const progress = await Progress.findOne({ userId: user!._id });
    const awardedFromProgress = progress!.lessons.reduce(
      (sum, row) => sum + (row.videoPointsAwarded ? RULES.VIDEO_POINTS : 0),
      0,
    );
    const refreshed = await User.findById(user!._id);
    expect(refreshed!.totalPoints).toBe(awardedFromProgress);
    expect(refreshed!.totalPoints).toBe(RULES.VIDEO_POINTS);
  });

  it("a 'user' cannot post a heartbeat for another user's progress", async () => {
    const { lessonId, courseId } = await seedPublishedLesson();
    const aliceToken = await loginAs('user', 'alice-hb@rva.test');
    const bobToken = await loginAs('user', 'bob-hb@rva.test');
    const alice = await User.findOne({ email: 'alice-hb@rva.test' });
    const bob = await User.findOne({ email: 'bob-hb@rva.test' });

    const aliceHb = await heartbeat(aliceToken, lessonId, { deltaSec: 7 });
    expect(aliceHb.status).toBe(200);

    const bobHb = await request(app)
      .post(`/api/lessons/${lessonId}/heartbeat`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({
        deltaSec: 3,
        playerPositionSec: 3,
        userId: alice!._id.toString(),
      });
    expect(bobHb.status).toBe(200);
    expect(bobHb.body.progress.watchedSec).toBe(3);

    const aliceProgress = await Progress.findOne({
      userId: alice!._id,
      courseId,
    });
    const bobProgress = await Progress.findOne({
      userId: bob!._id,
      courseId,
    });

    expect(aliceProgress!.lessons[0]!.watchedSec).toBe(7);
    expect(bobProgress!.lessons[0]!.watchedSec).toBe(3);
    expect(await Progress.countDocuments({ courseId })).toBe(2);
  });
});
