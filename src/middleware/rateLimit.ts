import { Redis } from '@upstash/redis';
import rateLimit, {
  ipKeyGenerator,
  type IncrementResponse,
  type Options,
  type Store,
} from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

function rateLimitedHandler(): AppError {
  return new AppError('RATE_LIMITED', 'Too many requests. Please try again later.');
}

let redisClient: Redis | null | undefined;

function getRedis(): Redis | null {
  if (env.NODE_ENV !== 'production') {
    return null;
  }
  if (redisClient !== undefined) {
    return redisClient;
  }
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    redisClient = null;
    return null;
  }
  redisClient = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return redisClient;
}

/**
 * Shared hit counter for serverless. Each limiter gets its own instance
 * (express-rate-limit forbids sharing one Store across middlewares).
 */
class UpstashRedisStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;

  constructor(
    private readonly redis: Redis,
    prefix: string,
  ) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private redisKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redisKey = this.redisKey(key);
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.pexpire(redisKey, this.windowMs);
    }
    const ttl = await this.redis.pttl(redisKey);
    return {
      totalHits: Number(count),
      resetTime: ttl > 0 ? new Date(Date.now() + ttl) : new Date(Date.now() + this.windowMs),
    };
  }

  async decrement(key: string): Promise<void> {
    await this.redis.decr(this.redisKey(key));
  }

  async resetKey(key: string): Promise<void> {
    await this.redis.del(this.redisKey(key));
  }
}

function createLimiter(params: {
  name: string;
  windowMs: number;
  limit: number;
  /** Login must fail closed — a Redis outage must not disable password throttling. */
  failClosed: boolean;
  skipSuccessfulRequests?: boolean;
  keyGenerator: (req: Request) => string;
}) {
  const redis = getRedis();
  return rateLimit({
    windowMs: params.windowMs,
    limit: params.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: params.skipSuccessfulRequests ?? false,
    passOnStoreError: !params.failClosed,
    keyGenerator: params.keyGenerator,
    handler: (_req, _res, next) => {
      next(rateLimitedHandler());
    },
    ...(redis ? { store: new UpstashRedisStore(redis, `rva:${params.name}:`) } : {}),
  });
}

export const loginRateLimiter = createLimiter({
  name: 'login',
  windowMs: 15 * 60 * 1000,
  limit: 5,
  failClosed: true,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return `${ipKeyGenerator(req.ip ?? 'unknown')}:${email}`;
  },
});

export const refreshRateLimiter = createLimiter({
  name: 'refresh',
  windowMs: 60 * 60 * 1000,
  limit: 20,
  failClosed: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'unknown'),
});

/** 6 heartbeats per minute per lesson per authenticated user. */
export const heartbeatRateLimiter = createLimiter({
  name: 'heartbeat',
  windowMs: 60 * 1000,
  limit: 6,
  failClosed: false,
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? 'anonymous';
    const lessonId = typeof req.params.id === 'string' ? req.params.id : 'unknown';
    return `${userId}:${lessonId}`;
  },
});

/** 20 thumbnail uploads per hour per authenticated admin. */
export const uploadRateLimiter = createLimiter({
  name: 'upload',
  windowMs: 60 * 60 * 1000,
  limit: 20,
  failClosed: false,
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? 'anonymous';
    return `upload:${userId}`;
  },
});

/** 10 quiz submissions per hour per quiz (lesson or final exam) per user. */
export const quizSubmitRateLimiter = createLimiter({
  name: 'quiz-submit',
  windowMs: 60 * 60 * 1000,
  limit: 10,
  failClosed: false,
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? 'anonymous';
    const lessonId =
      typeof req.params.lessonId === 'string' ? req.params.lessonId : null;
    const courseId =
      typeof req.params.courseId === 'string' ? req.params.courseId : null;
    const quizKey = lessonId ? `lesson:${lessonId}` : `course:${courseId ?? 'unknown'}`;
    return `${userId}:${quizKey}`;
  },
});
