import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';

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
    await Promise.all([User.deleteMany({}), RefreshToken.deleteMany({})]);
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
});
