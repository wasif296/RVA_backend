import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const base = {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/lms',
  CORS_ORIGIN: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  LOG_LEVEL: 'info',
  APP_URL: 'http://localhost:5173',
};

describe('env schema', () => {
  it('rejects a wildcard CORS_ORIGIN', () => {
    const result = parseEnv({ ...base, CORS_ORIGIN: '*' });
    expect(result.success).toBe(false);
  });

  it('accepts a comma-separated CORS allowlist', () => {
    const result = parseEnv({
      ...base,
      CORS_ORIGIN: 'http://localhost:5173, https://rva.example',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.CORS_ORIGIN).toEqual([
        'http://localhost:5173',
        'https://rva.example',
      ]);
    }
  });

  it('requires Upstash and Cloudinary in production', () => {
    const result = parseEnv({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(result.success).toBe(false);
  });

  it('accepts production when Upstash and Cloudinary are set', () => {
    const result = parseEnv({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.example.com',
      STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'key',
      CLOUDINARY_API_SECRET: 'secret',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      RESEND_API_KEY: 're_live_example',
      EMAIL_FROM: 'RVA Academy <no-reply@rva.academy>',
    });
    expect(result.success).toBe(true);
  });

  it('requires RESEND_API_KEY and EMAIL_FROM in production', () => {
    const result = parseEnv({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.example.com',
      STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: 'key',
      CLOUDINARY_API_SECRET: 'secret',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    expect(result.success).toBe(false);
  });

  it('requires APP_URL to be a valid URL', () => {
    const result = parseEnv({ ...base, APP_URL: 'not-a-url' });
    expect(result.success).toBe(false);
  });
});
