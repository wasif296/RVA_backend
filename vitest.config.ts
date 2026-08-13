import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15_000,
    env: {
      NODE_ENV: 'test',
      PORT: '4000',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/lms_test',
      CORS_ORIGIN: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'test-access-secret-min-32-characters!!',
      JWT_REFRESH_SECRET: 'test-refresh-secret-min-32-characters!',
      LOG_LEVEL: 'silent',
      UPLOAD_DIR: './uploads-test',
      PUBLIC_UPLOAD_BASE_URL: '/uploads',
      STORAGE_DRIVER: 'local',
      CLOUDINARY_CLOUD_NAME: '',
      CLOUDINARY_API_KEY: '',
      CLOUDINARY_API_SECRET: '',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
    },
  },
});
