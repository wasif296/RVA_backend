import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as lessonsController from './lessons.controller.js';
import {
  courseIdParamsSchema,
  createLessonBodySchema,
  lessonIdParamsSchema,
  reorderLessonsBodySchema,
  updateLessonBodySchema,
} from './lessons.schema.js';

/** Nested under /api/courses/:courseId/lessons */
export const courseLessonsRouter = Router({ mergeParams: true });

courseLessonsRouter.use(authenticate, requirePasswordCurrent);

courseLessonsRouter.get(
  '/',
  validate(courseIdParamsSchema, 'params'),
  lessonsController.listLessons,
);

courseLessonsRouter.post(
  '/',
  requireRole('super_admin'),
  validate(courseIdParamsSchema, 'params'),
  validate(createLessonBodySchema, 'body'),
  lessonsController.createLesson,
);

courseLessonsRouter.patch(
  '/reorder',
  requireRole('super_admin'),
  validate(courseIdParamsSchema, 'params'),
  validate(reorderLessonsBodySchema, 'body'),
  lessonsController.reorderLessons,
);

/** Mounted at /api/lessons */
export const lessonsRouter = Router();

lessonsRouter.use(authenticate, requirePasswordCurrent);

lessonsRouter.get(
  '/:id',
  validate(lessonIdParamsSchema, 'params'),
  lessonsController.getLesson,
);

lessonsRouter.patch(
  '/:id',
  requireRole('super_admin'),
  validate(lessonIdParamsSchema, 'params'),
  validate(updateLessonBodySchema, 'body'),
  lessonsController.updateLesson,
);

lessonsRouter.delete(
  '/:id',
  requireRole('super_admin'),
  validate(lessonIdParamsSchema, 'params'),
  lessonsController.deleteLesson,
);
