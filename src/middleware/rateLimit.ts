import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../utils/AppError.js';

function rateLimitedHandler(): AppError {
  return new AppError('RATE_LIMITED', 'Too many requests. Please try again later.');
}

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return `${ipKeyGenerator(req.ip ?? 'unknown')}:${email}`;
  },
  handler: (_req, _res, next) => {
    next(rateLimitedHandler());
  },
});

export const refreshRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'unknown'),
  handler: (_req, _res, next) => {
    next(rateLimitedHandler());
  },
});

/** 6 heartbeats per minute per lesson per authenticated user. */
export const heartbeatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? 'anonymous';
    const lessonId = typeof req.params.id === 'string' ? req.params.id : 'unknown';
    return `${userId}:${lessonId}`;
  },
  handler: (_req, _res, next) => {
    next(rateLimitedHandler());
  },
});

/** 20 thumbnail uploads per hour per authenticated admin. */
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? 'anonymous';
    return `upload:${userId}`;
  },
  handler: (_req, _res, next) => {
    next(rateLimitedHandler());
  },
});

/** 10 quiz submissions per hour per quiz (lesson or final exam) per user. */
export const quizSubmitRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = req.user?.id ?? 'anonymous';
    const lessonId =
      typeof req.params.lessonId === 'string' ? req.params.lessonId : null;
    const courseId =
      typeof req.params.courseId === 'string' ? req.params.courseId : null;
    const quizKey = lessonId ? `lesson:${lessonId}` : `course:${courseId ?? 'unknown'}`;
    return `${userId}:${quizKey}`;
  },
  handler: (_req, _res, next) => {
    next(rateLimitedHandler());
  },
});
