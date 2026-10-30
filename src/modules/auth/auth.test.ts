import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { InviteToken } from '../../models/InviteToken.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';
import { issueInviteToken } from './inviteToken.service.js';

function extractRefreshCookie(setCookie: string[] | string | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const refresh = cookies.find((value) => value.startsWith('refreshToken='));
  if (!refresh) {
    throw new Error('refreshToken cookie not set');
  }
  return refresh.split(';')[0] ?? refresh;
}

describe('Phase 4 auth', () => {
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
      RefreshToken.deleteMany({}),
      InviteToken.deleteMany({}),
    ]);
  });

  async function createUser(overrides?: {
    email?: string;
    password?: string;
    role?: 'super_admin' | 'user';
    isActive?: boolean;
    mustChangePassword?: boolean;
  }) {
    const password = overrides?.password ?? 'correct-horse-battery';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({
      name: 'Test User',
      email: overrides?.email ?? 'user@rva.test',
      passwordHash,
      role: overrides?.role ?? 'user',
      isActive: overrides?.isActive ?? true,
      mustChangePassword: overrides?.mustChangePassword ?? false,
    });
    return { user, password };
  }

  it('login succeeds and returns an access token plus a refresh cookie', async () => {
    const { password } = await createUser();

    const res = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.email).toBe('user@rva.test');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(extractRefreshCookie(res.headers['set-cookie'])).toMatch(/^refreshToken=/);
  });

  it('wrong password and unknown email return the identical error body', async () => {
    const { password } = await createUser();

    const wrongPassword = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password: 'definitely-wrong-password',
    });
    const unknownEmail = await request(app).post('/api/auth/login').send({
      email: 'missing@rva.test',
      password,
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('an inactive user cannot log in', async () => {
    const { password } = await createUser({ isActive: false });

    const res = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('/me without a token returns UNAUTHENTICATED', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('/me with a valid token returns the user and never returns passwordHash', async () => {
    const { password } = await createUser();
    const login = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user@rva.test');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it("a 'user' role hitting a requireRole('super_admin') test route returns FORBIDDEN", async () => {
    const { password } = await createUser({ role: 'user' });
    const login = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });

    const res = await request(app)
      .get('/api/auth/__test/admin')
      .set('Authorization', `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refresh rotates the token and the OLD refresh token stops working', async () => {
    const { password } = await createUser();
    const login = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });
    const oldCookie = extractRefreshCookie(login.headers['set-cookie']);

    const rotated = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', oldCookie);

    expect(rotated.status).toBe(200);
    expect(rotated.body.accessToken).toEqual(expect.any(String));
    const newCookie = extractRefreshCookie(rotated.headers['set-cookie']);
    expect(newCookie).not.toBe(oldCookie);

    const replayOld = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', oldCookie);

    expect(replayOld.status).toBe(401);
    expect(replayOld.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('replaying a revoked refresh token revokes the whole family', async () => {
    const { password } = await createUser();
    const login = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });
    const firstCookie = extractRefreshCookie(login.headers['set-cookie']);

    const rotated = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookie);
    const secondCookie = extractRefreshCookie(rotated.headers['set-cookie']);

    await request(app).post('/api/auth/refresh').set('Cookie', firstCookie);

    const replaySecond = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', secondCookie);

    expect(replaySecond.status).toBe(401);
    expect(replaySecond.body.error.code).toBe('UNAUTHENTICATED');

    const user = await User.findOne({ email: 'user@rva.test' });
    const tokens = await RefreshToken.find({ userId: user?._id });
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token.revokedAt != null)).toBe(true);
  });

  it('change-password increments tokenVersion so the previous access token stops working', async () => {
    const { password } = await createUser();
    const login = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });
    const oldAccess = login.body.accessToken as string;

    const change = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${oldAccess}`)
      .send({
        currentPassword: password,
        newPassword: 'brand-new-password-1',
      });

    expect(change.status).toBe(204);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${oldAccess}`);

    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('mustChangePassword users can call /me but are blocked on other authenticated routes', async () => {
    const { password } = await createUser({
      role: 'super_admin',
      mustChangePassword: true,
    });
    const login = await request(app).post('/api/auth/login').send({
      email: 'user@rva.test',
      password,
    });
    const access = login.body.accessToken as string;

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${access}`);
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    expect(me.body.user.email).toBe('user@rva.test');

    const protectedRoute = await request(app)
      .get('/api/auth/__test/admin')
      .set('Authorization', `Bearer ${access}`);
    expect(protectedRoute.status).toBe(403);
    expect(protectedRoute.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const change = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${access}`)
      .send({
        currentPassword: password,
        newPassword: 'brand-new-password-2',
      });
    expect(change.status).toBe(204);
  });

  it('the login rate limiter returns RATE_LIMITED after 5 failed attempts', async () => {
    await createUser({ email: 'limited@rva.test' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app).post('/api/auth/login').send({
        email: 'limited@rva.test',
        password: 'wrong-password-value',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }

    const limited = await request(app).post('/api/auth/login').send({
      email: 'limited@rva.test',
      password: 'wrong-password-value',
    });

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('a user with no passwordHash gets the identical generic error as a wrong password', async () => {
    await User.create({
      name: 'Pending',
      email: 'pending@rva.test',
      role: 'user',
    });
    const { password } = await createUser({ email: 'active@rva.test' });

    const noPassword = await request(app).post('/api/auth/login').send({
      email: 'pending@rva.test',
      password,
    });
    const wrongPassword = await request(app).post('/api/auth/login').send({
      email: 'active@rva.test',
      password: 'definitely-wrong-password',
    });

    expect(noPassword.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(noPassword.body).toEqual(wrongPassword.body);
    expect(noPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(JSON.stringify(noPassword.body)).not.toMatch(/activat/i);
  });

  it('GET /invite/:token returns only name and email', async () => {
    const user = await User.create({
      name: 'Invited Learner',
      email: 'invited@rva.test',
      role: 'user',
    });
    const token = await issueInviteToken({ userId: user._id, purpose: 'invite' });

    const res = await request(app).get(`/api/auth/invite/${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Invited Learner', email: 'invited@rva.test' });
  });

  it('an invite token works once, then is rejected as used', async () => {
    const user = await User.create({
      name: 'Once Only',
      email: 'once@rva.test',
      role: 'user',
    });
    const token = await issueInviteToken({ userId: user._id, purpose: 'invite' });

    const first = await request(app)
      .post(`/api/auth/invite/${token}/accept`)
      .send({ password: 'brand-new-password-1' });
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    expect(first.body.user.email).toBe('once@rva.test');
    expect(first.body.user.mustChangePassword).toBe(false);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${first.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('once@rva.test');

    const second = await request(app)
      .post(`/api/auth/invite/${token}/accept`)
      .send({ password: 'another-password-12' });
    const secondGet = await request(app).get(`/api/auth/invite/${token}`);

    expect(second.status).toBe(400);
    expect(secondGet.status).toBe(400);
    expect(second.body).toEqual(secondGet.body);
    expect(second.body.error.code).toBe('INVALID_INVITE_TOKEN');
    expect(second.body.error.message).toBe('This link is invalid or has expired');
  });

  it('accepting an invite returns a working access token', async () => {
    const user = await User.create({
      name: 'Token User',
      email: 'tokenuser@rva.test',
      role: 'user',
    });
    const token = await issueInviteToken({ userId: user._id, purpose: 'invite' });

    const accept = await request(app)
      .post(`/api/auth/invite/${token}/accept`)
      .send({ password: 'working-access-12' });

    expect(accept.status).toBe(200);
    expect(accept.body.accessToken).toEqual(expect.any(String));
    expect(extractRefreshCookie(accept.headers['set-cookie'])).toMatch(/^refreshToken=/);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accept.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('tokenuser@rva.test');
    expect(me.body.user.mustChangePassword).toBe(false);
  });

  it('expired and tampered tokens are rejected with the same generic error', async () => {
    const user = await User.create({
      name: 'Expiry',
      email: 'expiry@rva.test',
      role: 'user',
    });
    const expiredToken = await issueInviteToken({ userId: user._id, purpose: 'invite' });
    await InviteToken.updateMany(
      { userId: user._id, purpose: 'invite' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const other = await User.create({
      name: 'Tamper',
      email: 'tamper@rva.test',
      role: 'user',
    });
    const realToken = await issueInviteToken({ userId: other._id, purpose: 'invite' });
    const tamperedToken = `${realToken.slice(0, -1)}${realToken.endsWith('a') ? 'b' : 'a'}`;

    const expiredGet = await request(app).get(`/api/auth/invite/${expiredToken}`);
    const expiredPost = await request(app)
      .post(`/api/auth/invite/${expiredToken}/accept`)
      .send({ password: 'brand-new-password-1' });
    const tamperedGet = await request(app).get(`/api/auth/invite/${tamperedToken}`);
    const tamperedPost = await request(app)
      .post(`/api/auth/invite/${tamperedToken}/accept`)
      .send({ password: 'brand-new-password-1' });

    expect(expiredGet.status).toBe(400);
    expect(expiredPost.status).toBe(400);
    expect(tamperedGet.status).toBe(400);
    expect(tamperedPost.status).toBe(400);
    expect(expiredGet.body).toEqual(expiredPost.body);
    expect(expiredGet.body).toEqual(tamperedGet.body);
    expect(expiredGet.body).toEqual(tamperedPost.body);
    expect(expiredGet.body.error.code).toBe('INVALID_INVITE_TOKEN');
    expect(expiredGet.body.error.message).toBe('This link is invalid or has expired');
  });
});
