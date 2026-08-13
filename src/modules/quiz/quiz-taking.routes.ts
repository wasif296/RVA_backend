import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { quizSubmitRateLimiter } from '../../middleware/rateLimit.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as quizTakingController from './quiz-taking.controller.js';
import {
  courseIdParamsSchema,
  lessonIdParamsSchema,
  submitFinalExamBodySchema,
  submitQuizBodySchema,
} from './quiz-taking.schema.js';

/** Mounted at /api/lessons/:lessonId/quiz — learner taking (before admin router). */
export const quizTakingLessonRouter = Router({ mergeParams: true });

quizTakingLessonRouter.use(authenticate, requirePasswordCurrent);

quizTakingLessonRouter.get(
  '/',
  requireRole('user'),
  validate(lessonIdParamsSchema, 'params'),
  quizTakingController.getLessonQuiz,
);

quizTakingLessonRouter.post(
  '/submit',
  requireRole('user'),
  quizSubmitRateLimiter,
  validate(lessonIdParamsSchema, 'params'),
  validate(submitQuizBodySchema, 'body'),
  quizTakingController.submitLessonQuiz,
);

quizTakingLessonRouter.get(
  '/attempts',
  requireRole('user'),
  validate(lessonIdParamsSchema, 'params'),
  quizTakingController.listLessonAttempts,
);

/** Mounted at /api/courses/:courseId/final-exam — learner taking (before admin router). */
export const quizTakingFinalExamRouter = Router({ mergeParams: true });

quizTakingFinalExamRouter.use(authenticate, requirePasswordCurrent);

quizTakingFinalExamRouter.get(
  '/',
  requireRole('user'),
  validate(courseIdParamsSchema, 'params'),
  quizTakingController.getFinalExam,
);

quizTakingFinalExamRouter.post(
  '/submit',
  requireRole('user'),
  quizSubmitRateLimiter,
  validate(courseIdParamsSchema, 'params'),
  validate(submitFinalExamBodySchema, 'body'),
  quizTakingController.submitFinalExam,
);

quizTakingFinalExamRouter.get(
  '/submission',
  requireRole('user'),
  validate(courseIdParamsSchema, 'params'),
  quizTakingController.getFinalExamSubmission,
);
