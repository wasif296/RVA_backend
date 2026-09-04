import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as gradingController from './grading.controller.js';
import {
  examSubmissionIdParamsSchema,
  gradeExamSubmissionBodySchema,
  listExamSubmissionsQuerySchema,
} from './grading.schema.js';

/** Mounted at /api/admin/exam-submissions — super_admin only. */
export const gradingRouter = Router();

gradingRouter.use(authenticate, requirePasswordCurrent, requireRole('super_admin'));

gradingRouter.get(
  '/',
  validate(listExamSubmissionsQuerySchema, 'query'),
  gradingController.listExamSubmissions,
);

gradingRouter.get(
  '/:id',
  validate(examSubmissionIdParamsSchema, 'params'),
  gradingController.getExamSubmission,
);

gradingRouter.post(
  '/:id/grade',
  validate(examSubmissionIdParamsSchema, 'params'),
  validate(gradeExamSubmissionBodySchema, 'body'),
  gradingController.gradeExamSubmission,
);

/** Mounted at /api/badges — learner. */
export const badgesRouter = Router();

badgesRouter.use(authenticate, requirePasswordCurrent, requireRole('user'));

badgesRouter.get('/', gradingController.listMyBadges);
