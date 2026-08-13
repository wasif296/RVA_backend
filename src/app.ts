import express from 'express';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { coursesRouter } from './modules/courses/courses.routes.js';
import {
  courseLessonsRouter,
  lessonsRouter,
} from './modules/lessons/lessons.routes.js';
import { quizRouter, finalExamRouter } from './modules/quiz/quiz.routes.js';
import {
  quizTakingFinalExamRouter,
  quizTakingLessonRouter,
} from './modules/quiz/quiz-taking.routes.js';
import {
  adminProgressRouter,
  progressRouter,
} from './modules/progress/progress.routes.js';
import { watchRouter } from './modules/watch/watch.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';
import {
  createStorageAdapter,
  setStorageAdapter,
} from './modules/uploads/storage.adapter.js';
import {
  badgesRouter,
  gradingRouter,
} from './modules/grading/grading.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';

export function createApp() {
  setStorageAdapter(createStorageAdapter(env.STORAGE_DRIVER));

  const app = express();

  // Vercel terminates TLS at one proxy hop. trust proxy 1 lets Express read
  // X-Forwarded-For so rate limits key on the real client IP. Do not set
  // `true` — express-rate-limit rejects a fully permissive trust proxy.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  const uploadRoot = path.resolve(env.UPLOAD_DIR);
  app.use(
    env.PUBLIC_UPLOAD_BASE_URL,
    express.static(uploadRoot, {
      dotfiles: 'deny',
      index: false,
      fallthrough: true,
    }),
  );

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/uploads', uploadsRouter);
  // Learner quiz-taking mounts BEFORE admin routers so GET / is not blocked by requireRole('super_admin').
  app.use('/api/courses/:courseId/final-exam', quizTakingFinalExamRouter);
  app.use('/api/courses/:courseId/final-exam', finalExamRouter);
  app.use('/api/courses/:courseId/lessons', courseLessonsRouter);
  app.use('/api/courses', coursesRouter);
  app.use('/api/lessons/:lessonId/quiz', quizTakingLessonRouter);
  app.use('/api/lessons/:lessonId/quiz', quizRouter);
  app.use('/api/lessons', watchRouter);
  app.use('/api/lessons', lessonsRouter);
  app.use('/api/progress', progressRouter);
  app.use('/api/admin/progress', adminProgressRouter);
  app.use('/api/admin/exam-submissions', gradingRouter);
  app.use('/api/badges', badgesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
