import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as quizController from './quiz.controller.js';
import {
  courseIdParamsSchema,
  lessonIdParamsSchema,
  upsertFinalExamBodySchema,
  upsertQuizBodySchema,
} from './quiz.schema.js';

/** Mounted at /api/lessons/:lessonId/quiz — super_admin only. */
export const quizRouter = Router({ mergeParams: true });

quizRouter.use(authenticate, requirePasswordCurrent, requireRole('super_admin'));

quizRouter.get(
  '/admin',
  validate(lessonIdParamsSchema, 'params'),
  quizController.getLessonQuizAdmin,
);

quizRouter.put(
  '/',
  validate(lessonIdParamsSchema, 'params'),
  validate(upsertQuizBodySchema, 'body'),
  quizController.upsertLessonQuiz,
);

quizRouter.delete(
  '/',
  validate(lessonIdParamsSchema, 'params'),
  quizController.deleteLessonQuiz,
);

/** Mounted at /api/courses/:courseId/final-exam — super_admin only. */
export const finalExamRouter = Router({ mergeParams: true });

finalExamRouter.use(authenticate, requirePasswordCurrent, requireRole('super_admin'));

finalExamRouter.get(
  '/admin',
  validate(courseIdParamsSchema, 'params'),
  quizController.getFinalExamAdmin,
);

finalExamRouter.put(
  '/',
  validate(courseIdParamsSchema, 'params'),
  validate(upsertFinalExamBodySchema, 'body'),
  quizController.upsertFinalExam,
);

finalExamRouter.delete(
  '/',
  validate(courseIdParamsSchema, 'params'),
  quizController.deleteFinalExam,
);
