import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as coursesController from './courses.controller.js';
import {
  courseIdParamsSchema,
  createCourseBodySchema,
  listCoursesQuerySchema,
  updateCourseBodySchema,
} from './courses.schema.js';

export const coursesRouter = Router();

coursesRouter.use(authenticate, requirePasswordCurrent);

coursesRouter.get(
  '/',
  validate(listCoursesQuerySchema, 'query'),
  coursesController.listCourses,
);

coursesRouter.get(
  '/:id/deletion-impact',
  requireRole('super_admin'),
  validate(courseIdParamsSchema, 'params'),
  coursesController.getCourseDeletionImpact,
);

coursesRouter.get(
  '/:id',
  validate(courseIdParamsSchema, 'params'),
  coursesController.getCourse,
);

coursesRouter.post(
  '/',
  requireRole('super_admin'),
  validate(createCourseBodySchema, 'body'),
  coursesController.createCourse,
);

coursesRouter.patch(
  '/:id',
  requireRole('super_admin'),
  validate(courseIdParamsSchema, 'params'),
  validate(updateCourseBodySchema, 'body'),
  coursesController.updateCourse,
);

coursesRouter.delete(
  '/:id',
  requireRole('super_admin'),
  validate(courseIdParamsSchema, 'params'),
  coursesController.deleteCourse,
);
