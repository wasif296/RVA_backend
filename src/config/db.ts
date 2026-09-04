import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true);

/** Keep the pool small — many serverless instances may be warm at once. */
const MAX_POOL_SIZE = 5;

const READY_STATE_MAP = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
} as const;

export type DatabaseStatus =
  | 'disconnected'
  | 'connected'
  | 'connecting'
  | 'disconnecting'
  | 'unknown';

type MongooseCache = {
  promise: Promise<typeof mongoose> | null;
};

const globalForMongo = globalThis as typeof globalThis & {
  __rvaMongoose?: MongooseCache;
};

function getCache(): MongooseCache {
  if (!globalForMongo.__rvaMongoose) {
    globalForMongo.__rvaMongoose = { promise: null };
  }
  return globalForMongo.__rvaMongoose;
}

/**
 * Reuse one Mongoose connection across serverless invocations.
 * Await the cached promise — do not open a new connection per request.
 */
export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  const cache = getCache();
  if (!cache.promise) {
    cache.promise = mongoose.connect(env.MONGODB_URI, {
      maxPoolSize: MAX_POOL_SIZE,
    });
  }

  try {
    await cache.promise;
    logger.info('MongoDB connected');
  } catch (error) {
    cache.promise = null;
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  const cache = getCache();
  cache.promise = null;
  if (mongoose.connection.readyState === 0) {
    return;
  }
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
}

export function databaseStatus(): DatabaseStatus {
  return READY_STATE_MAP[mongoose.connection.readyState as keyof typeof READY_STATE_MAP] ?? 'unknown';
}
