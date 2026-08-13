import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { env, parseEnv } from '../../config/env.js';
import { User } from '../../models/User.js';
import { CloudinaryAdapter } from './cloudinary.adapter.js';
import {
  createStorageAdapter,
  getStorageAdapter,
  LocalDiskAdapter,
  resetStorageAdapterForTests,
  setStorageAdapter,
} from './storage.adapter.js';

const cloudinaryMocks = vi.hoisted(() => ({
  lastBuffer: null as Buffer | null,
  uploadStream: vi.fn(),
  destroy: vi.fn().mockResolvedValue({ result: 'ok' }),
  url: vi.fn(
    (id: string) => `http://res.cloudinary.com/demo/image/upload/${id}.webp`,
  ),
  config: vi.fn(),
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: cloudinaryMocks.config,
    url: cloudinaryMocks.url,
    uploader: {
      upload_stream: cloudinaryMocks.uploadStream,
      destroy: cloudinaryMocks.destroy,
    },
  },
}));

describe('Uploads — course thumbnails', () => {
  let mongod: MongoMemoryServer;
  const app = createApp();
  const uploadRoot = path.resolve(env.UPLOAD_DIR);

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await mkdir(uploadRoot, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    await rm(uploadRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await rm(uploadRoot, { recursive: true, force: true });
    await mkdir(uploadRoot, { recursive: true });
    resetStorageAdapterForTests();
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

  async function makePng(width = 32, height = 24): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 20, g: 120, b: 90 },
      },
    })
      .png()
      .toBuffer();
  }

  it("a 'user' role gets FORBIDDEN", async () => {
    const token = await loginAs('user', 'user-upload@rva.test');
    const png = await makePng();

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, 'thumb.png');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a valid png uploads and returns a usable url', async () => {
    const token = await loginAs('super_admin', 'admin-upload@rva.test');
    const png = await makePng(64, 40);

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, 'course.png');

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]+\.webp$/i);

    const storedName = path.basename(res.body.url as string);
    const storedPath = path.join(uploadRoot, storedName);
    const stored = await readFile(storedPath);
    expect(stored.length).toBeGreaterThan(0);

    const served = await request(app).get(res.body.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/image\/webp/i);
  });

  it('a file over 5MB is rejected', async () => {
    const token = await loginAs('super_admin', 'admin-big@rva.test');
    // Slightly over the limit — multer rejects before we buffer into sharp.
    const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 1);

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', huge, 'big.png');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/5MB/i);
  });

  it('a text file renamed to .png is rejected by magic-byte validation', async () => {
    const token = await loginAs('super_admin', 'admin-fake@rva.test');
    const fake = Buffer.from('not-an-image-at-all');

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fake, {
        filename: 'evil.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/Invalid image/i);
  });

  it('a filename containing ../ cannot escape the upload directory', async () => {
    const token = await loginAs('super_admin', 'admin-traversal@rva.test');
    const png = await makePng();

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, {
        filename: '../../../etc/passwd.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(201);
    const url = res.body.url as string;
    expect(url.includes('..')).toBe(false);
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]+\.webp$/i);

    const storedName = path.basename(url);
    const storedPath = path.resolve(uploadRoot, storedName);
    expect(storedPath.startsWith(path.resolve(uploadRoot) + path.sep)).toBe(true);

    // Nothing written outside the upload root.
    const outside = path.resolve(uploadRoot, '..', 'passwd.png');
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the stored file is re-encoded (output is webp, not the original bytes)', async () => {
    const token = await loginAs('super_admin', 'admin-reencode@rva.test');
    const png = await makePng(48, 48);
    const originalHash = createHash('sha256').update(png).digest('hex');

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, 'original.png');

    expect(res.status).toBe(201);
    const stored = await readFile(path.join(uploadRoot, path.basename(res.body.url)));
    const storedHash = createHash('sha256').update(stored).digest('hex');
    expect(storedHash).not.toBe(originalHash);

    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('webp');
  });

  it('EXIF present in the input is absent from the output', async () => {
    const token = await loginAs('super_admin', 'admin-exif@rva.test');
    const withExif = await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg()
      .withExif({
        IFD0: { Copyright: 'SECRET-EXIF-MARKER' },
      })
      .toBuffer();

    const inputMeta = await sharp(withExif).metadata();
    expect(inputMeta.exif).toBeTruthy();

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', withExif, 'with-exif.jpg');

    expect(res.status).toBe(201);
    const stored = await readFile(path.join(uploadRoot, path.basename(res.body.url)));
    const outputMeta = await sharp(stored).metadata();
    expect(outputMeta.format).toBe('webp');
    expect(outputMeta.exif).toBeUndefined();
    expect(stored.includes(Buffer.from('SECRET-EXIF-MARKER'))).toBe(false);
  });
});

const baseEnv = {
  NODE_ENV: 'test',
  PORT: '4000',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/lms_test',
  CORS_ORIGIN: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'test-access-secret-min-32-characters!!',
  JWT_REFRESH_SECRET: 'test-refresh-secret-min-32-characters!',
  LOG_LEVEL: 'silent',
  UPLOAD_DIR: './uploads-test',
  PUBLIC_UPLOAD_BASE_URL: '/uploads',
} satisfies NodeJS.ProcessEnv;

describe('STORAGE_DRIVER env + adapter wiring', () => {
  it('selects LocalDiskAdapter when STORAGE_DRIVER is local', () => {
    const adapter = createStorageAdapter('local');
    expect(adapter).toBeInstanceOf(LocalDiskAdapter);
  });

  it('selects CloudinaryAdapter when STORAGE_DRIVER is cloudinary', () => {
    expect(() => createStorageAdapter('cloudinary')).toThrow(/CLOUDINARY/);
    const adapter = new CloudinaryAdapter({
      cloudName: 'demo',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    expect(adapter).toBeInstanceOf(CloudinaryAdapter);
    setStorageAdapter(adapter);
    expect(getStorageAdapter()).toBeInstanceOf(CloudinaryAdapter);
  });

  it("createApp wires the local adapter from STORAGE_DRIVER 'local'", () => {
    resetStorageAdapterForTests();
    createApp();
    expect(getStorageAdapter()).toBeInstanceOf(LocalDiskAdapter);
  });

  it("fails fast when STORAGE_DRIVER is 'cloudinary' and credentials are missing", () => {
    const result = parseEnv({ ...baseEnv, STORAGE_DRIVER: 'cloudinary' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
      ]),
    );
  });

  it("allows missing Cloudinary vars when STORAGE_DRIVER is 'local'", () => {
    const result = parseEnv({ ...baseEnv, STORAGE_DRIVER: 'local' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.STORAGE_DRIVER).toBe('local');
  });

  it('defaults STORAGE_DRIVER to local when unset or empty', () => {
    expect(parseEnv({ ...baseEnv }).success).toBe(true);
    const empty = parseEnv({ ...baseEnv, STORAGE_DRIVER: '' });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    expect(empty.data.STORAGE_DRIVER).toBe('local');
  });

  it('accepts cloudinary when all credentials are present', () => {
    const result = parseEnv({
      ...baseEnv,
      STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'key',
      CLOUDINARY_API_SECRET: 'secret',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.STORAGE_DRIVER).toBe('cloudinary');
  });
});

describe('Cloudinary adapter (mocked SDK)', () => {
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
    await User.deleteMany({});
    cloudinaryMocks.lastBuffer = null;
    cloudinaryMocks.uploadStream.mockReset();
    cloudinaryMocks.destroy.mockClear();
    cloudinaryMocks.url.mockClear();
    cloudinaryMocks.uploadStream.mockImplementation(
      (
        opts: { public_id?: string },
        cb: (error: unknown, result?: unknown) => void,
      ) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _enc, next) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            next();
          },
          final(next) {
            cloudinaryMocks.lastBuffer = Buffer.concat(chunks);
            cb(undefined, {
              public_id: `rva/thumbnails/${opts.public_id ?? 'generated'}`,
              secure_url: `https://res.cloudinary.com/demo/image/upload/rva/thumbnails/${opts.public_id}.webp`,
            });
            next();
          },
        });
      },
    );
    setStorageAdapter(
      new CloudinaryAdapter({
        cloudName: 'demo',
        apiKey: 'key',
        apiSecret: 'secret',
      }),
    );
  });

  async function loginAsAdmin(email: string) {
    const password = 'test-password-12';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await User.create({
      name: 'Admin',
      email,
      passwordHash,
      role: 'super_admin',
      mustChangePassword: false,
    });
    const login = await request(app).post('/api/auth/login').send({ email, password });
    return login.body.accessToken as string;
  }

  it('rejects a fake png before any Cloudinary upload call', async () => {
    const token = await loginAsAdmin('admin-cloud-fake@rva.test');
    const fake = Buffer.from('not-an-image-at-all');

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fake, {
        filename: 'evil.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(cloudinaryMocks.uploadStream).not.toHaveBeenCalled();
  });

  it('rejects an oversized file before any Cloudinary upload call', async () => {
    const token = await loginAsAdmin('admin-cloud-big@rva.test');
    const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 1);

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', huge, 'big.png');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(cloudinaryMocks.uploadStream).not.toHaveBeenCalled();
  });

  it('uploads the re-encoded webp buffer, not the original bytes', async () => {
    const token = await loginAsAdmin('admin-cloud-webp@rva.test');
    const png = await sharp({
      create: {
        width: 48,
        height: 48,
        channels: 3,
        background: { r: 20, g: 80, b: 40 },
      },
    })
      .png()
      .toBuffer();
    const originalHash = createHash('sha256').update(png).digest('hex');

    const res = await request(app)
      .post('/api/uploads/thumbnail')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, 'original.png');

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^https:\/\//);
    expect(cloudinaryMocks.uploadStream).toHaveBeenCalledTimes(1);
    expect(cloudinaryMocks.lastBuffer).toBeTruthy();
    const uploaded = cloudinaryMocks.lastBuffer!;
    expect(createHash('sha256').update(uploaded).digest('hex')).not.toBe(originalHash);
    const meta = await sharp(uploaded).metadata();
    expect(meta.format).toBe('webp');
  });

  it('getPublicUrl returns https only; delete uses public_id', async () => {
    const adapter = new CloudinaryAdapter({
      cloudName: 'demo',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const url = adapter.getPublicUrl('rva/thumbnails/abc');
    expect(url.startsWith('https://')).toBe(true);
    expect(url.startsWith('http://')).toBe(false);

    await adapter.delete('rva/thumbnails/abc');
    expect(cloudinaryMocks.destroy).toHaveBeenCalledWith('rva/thumbnails/abc', {
      resource_type: 'image',
    });
  });
});
