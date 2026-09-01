import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { InviteToken } from '../../models/InviteToken.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';

const sendMock = vi.fn().mockResolvedValue({ data: { id: 'test-email-id' }, error: null });

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

function extractInviteToken(): string {
  const lastCall = sendMock.mock.calls.at(-1)?.[0] as { text: string } | undefined;
  const match = lastCall?.text.match(/\/invite\/([0-9a-f]{64})/);
  if (!match) {
    throw new Error('invite token not found in the last sent email');
  }
  return match[1] as string;
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
    await Promise.all([
      User.deleteMany({}),
      RefreshToken.deleteMany({}),
      InviteToken.deleteMany({}),
    ]);
    sendMock.mockClear();
    sendMock.mockResolvedValue({ data: { id: 'test-email-id' }, error: null });
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

  it("a 'user' role gets FORBIDDEN on create and resend-invite", async () => {
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
    const resend = await request(app)
      .post('/api/users/507f1f77bcf86cd799439011/resend-invite')
      .set(headers);

    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');
    expect(create.body.error.code).toBe('FORBIDDEN');
    expect(patch.body.error.code).toBe('FORBIDDEN');
    expect(reset.body.error.code).toBe('FORBIDDEN');
    expect(resend.status).toBe(403);
    expect(resend.body.error.code).toBe('FORBIDDEN');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('creating a user sends exactly one email and returns no password or token', async () => {
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
    expect(res.body.emailSent).toBe(true);
    expect(res.body.user.email).toBe('new@rva.test');
    expect(res.body.user.status).toBe('pending');
    expect(res.body).not.toHaveProperty('temporaryPassword');
    expect(res.body).not.toHaveProperty('token');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(sendMock).toHaveBeenCalledTimes(1);

    const listed = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(JSON.stringify(listed.body)).not.toContain('passwordHash');
  });

  it('the stored token value does not equal the emailed token', async () => {
    const { accessToken } = await createAdmin();
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Token Check', email: 'tokencheck@rva.test', role: 'user' });

    const rawToken = extractInviteToken();
    const stored = await InviteToken.findOne({
      userId: created.body.user.id,
      purpose: 'invite',
    });

    expect(stored).not.toBeNull();
    expect(stored?.tokenHash).not.toBe(rawToken);
    expect(stored?.tokenHash.includes(rawToken)).toBe(false);
    expect(await argon2.verify(stored!.tokenHash, rawToken)).toBe(true);
  });

  it('a send failure still creates the user and returns emailSent false', async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { message: 'Resend API down' } });
    const { accessToken } = await createAdmin();

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Flaky Email', email: 'flaky@rva.test', role: 'user' });

    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.emailError).toBeTruthy();

    const stored = await User.findOne({ email: 'flaky@rva.test' });
    expect(stored).not.toBeNull();
  });

  it('resend-invite invalidates the previous token', async () => {
    const { accessToken } = await createAdmin();
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Resend Me', email: 'resend@rva.test', role: 'user' });

    const firstToken = extractInviteToken();

    const resend = await request(app)
      .post(`/api/users/${created.body.user.id}/resend-invite`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resend.status).toBe(200);
    expect(resend.body.emailSent).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2);

    const secondToken = extractInviteToken();
    expect(secondToken).not.toBe(firstToken);

    const oldTokenCheck = await request(app).get(`/api/auth/invite/${firstToken}`);
    expect(oldTokenCheck.status).toBe(400);
    expect(oldTokenCheck.body.error.code).toBe('INVALID_INVITE_TOKEN');

    const newTokenCheck = await request(app).get(`/api/auth/invite/${secondToken}`);
    expect(newTokenCheck.status).toBe(200);
    expect(newTokenCheck.body.email).toBe('resend@rva.test');
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

    const rawToken = extractInviteToken();
    const accept = await request(app)
      .post(`/api/auth/invite/${rawToken}/accept`)
      .send({ password: 'brand-new-password-1' });
    expect(accept.status).toBe(200);

    await request(app)
      .patch(`/api/users/${created.body.user.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ isActive: false });

    const login = await request(app).post('/api/auth/login').send({
      email: 'inactive@rva.test',
      password: 'brand-new-password-1',
    });

    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('admin reset-password emails a link and never reveals a password', async () => {
    const { accessToken } = await createAdmin();
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Reset Me', email: 'reset@rva.test', role: 'user' });

    const inviteToken = extractInviteToken();
    await request(app)
      .post(`/api/auth/invite/${inviteToken}/accept`)
      .send({ password: 'first-password-123' });

    sendMock.mockClear();

    const reset = await request(app)
      .post(`/api/users/${created.body.user.id}/reset-password`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(reset.status).toBe(200);
    expect(reset.body.emailSent).toBe(true);
    expect(reset.body).not.toHaveProperty('temporaryPassword');
    expect(sendMock).toHaveBeenCalledTimes(1);

    const resetToken = extractInviteToken();
    const resetAccept = await request(app)
      .post(`/api/auth/invite/${resetToken}/accept`)
      .send({ password: 'second-password-456' });
    expect(resetAccept.status).toBe(200);

    const oldLogin = await request(app).post('/api/auth/login').send({
      email: 'reset@rva.test',
      password: 'first-password-123',
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post('/api/auth/login').send({
      email: 'reset@rva.test',
      password: 'second-password-456',
    });
    expect(newLogin.status).toBe(200);
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
    expect(
      page1.body.data.every((u: { status: string }) => u.status === 'pending'),
    ).toBe(true);
  });
});
