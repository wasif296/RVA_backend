import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';
import { generatePassword } from '../../utils/generatePassword.js';

function extractRefreshCookie(setCookie: string[] | string | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const refresh = cookies.find((value) => value.startsWith('refreshToken='));
  if (!refresh) {
    throw new Error('refreshToken cookie not set');
  }
  return refresh.split(';')[0] ?? refresh;
}

describe('Phase 6 users', () => {
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

  async function createAdmin() {
    const password = 'admin-password-12';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const admin = await User.create({
      name: 'Admin',
      email: 'admin@rva.test',
      passwordHash,
      role: 'super_admin',
      mustChangePassword: false,
    });
    const login = await request(app).post('/api/auth/login').send({
      email: 'admin@rva.test',
      password,
    });
    return {
      admin,
      accessToken: login.body.accessToken as string,
      password,
    };
  }

  async function createLearner() {
    const password = 'learner-password';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({
      name: 'Learner',
      email: 'learner@rva.test',
      passwordHash,
      role: 'user',
      mustChangePassword: false,
    });
    const login = await request(app).post('/api/auth/login').send({
      email: 'learner@rva.test',
      password,
    });
    return {
      user,
      accessToken: login.body.accessToken as string,
      password,
    };
  }

  it("a 'user' role gets FORBIDDEN on every users endpoint", async () => {
    const { accessToken } = await createLearner();
    const headers = { Authorization: `Bearer ${accessToken}` };

    const list = await request(app).get('/api/users').set(headers);
    const create = await request(app)
      .post('/api/users')
      .set(headers)
      .send({ name: 'X', email: 'x@rva.test', role: 'user' });
    const patch = await request(app)
      .patch('/api/users/507f1f77bcf86cd799439011')
      .set(headers)
      .send({ name: 'Nope' });
    const reset = await request(app)
      .post('/api/users/507f1f77bcf86cd799439011/reset-password')
      .set(headers);

    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');
    expect(create.body.error.code).toBe('FORBIDDEN');
    expect(patch.body.error.code).toBe('FORBIDDEN');
    expect(reset.body.error.code).toBe('FORBIDDEN');
  });

  it('creating a user returns a 16-character plaintext password exactly once', async () => {
    const { accessToken } = await createAdmin();

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'New Learner',
        email: 'new@rva.test',
        role: 'user',
      });

    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(res.body.user.email).toBe('new@rva.test');
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const listed = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(listed.body.data[0].temporaryPassword).toBeUndefined();
    expect(JSON.stringify(listed.body)).not.toContain('passwordHash');
    expect(JSON.stringify(listed.body)).not.toContain(res.body.temporaryPassword);
  });

  it('the created user can log in with that password and is forced to change it', async () => {
    const { accessToken } = await createAdmin();
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Forced Change',
        email: 'forced@rva.test',
        role: 'super_admin',
      });

    const login = await request(app).post('/api/auth/login').send({
      email: 'forced@rva.test',
      password: created.body.temporaryPassword,
    });

    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);

    const blocked = await request(app)
      .get('/api/auth/__test/admin')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('a duplicate email returns VALIDATION_ERROR, not a 500', async () => {
    const { accessToken } = await createAdmin();
    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'One', email: 'dup@rva.test', role: 'user' });

    const dup = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Two', email: 'dup@rva.test', role: 'user' });

    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('an admin cannot deactivate themselves', async () => {
    const { admin, accessToken } = await createAdmin();

    const res = await request(app)
      .patch(`/api/users/${admin._id.toString()}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ isActive: false });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a deactivated user can no longer log in', async () => {
    const { accessToken } = await createAdmin();
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Soon Inactive',
        email: 'inactive@rva.test',
        role: 'user',
      });

    await request(app)
      .patch(`/api/users/${created.body.user.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ isActive: false });

    const login = await request(app).post('/api/auth/login').send({
      email: 'inactive@rva.test',
      password: created.body.temporaryPassword,
    });

    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it("reset-password kills the target's existing refresh tokens", async () => {
    const { accessToken } = await createAdmin();
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Reset Me',
        email: 'reset@rva.test',
        role: 'user',
      });

    const targetLogin = await request(app).post('/api/auth/login').send({
      email: 'reset@rva.test',
      password: created.body.temporaryPassword,
    });
    expect(targetLogin.status).toBe(200);
    const cookie = extractRefreshCookie(targetLogin.headers['set-cookie']);

    const reset = await request(app)
      .post(`/api/users/${created.body.user.id}/reset-password`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(reset.status).toBe(200);
    expect(reset.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);

    const tokens = await RefreshToken.find({ userId: created.body.user.id });
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token.revokedAt != null)).toBe(true);

    const refresh = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(refresh.status).toBe(401);
  });

  it('pagination meta is correct, and passwordHash never appears in any response', async () => {
    const { accessToken } = await createAdmin();

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: `Learner ${i}`,
          email: `learner${i}@rva.test`,
          role: 'user',
        });
    }

    const page1 = await request(app)
      .get('/api/users')
      .query({ page: 1, limit: 2 })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta).toEqual({ page: 1, limit: 2, total: 4 });
    expect(JSON.stringify(page1.body)).not.toContain('passwordHash');

    const sample = generatePassword(16);
    expect(sample).toHaveLength(16);
    expect(sample).toMatch(/^[A-Za-z0-9]+$/);
  });
});
