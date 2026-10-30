import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as progressController from './progress.controller.js';
import { progressSummaryQuerySchema } from './progress.schema.js';

const adminProgressListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  courseId: z.string().optional(),
  sort: z
    .enum(['totalPoints', '-totalPoints', 'lastActivityAt', '-lastActivityAt'])
    .optional(),
});

const adminUserProgressParamsSchema = z.object({
  userId: z.string().min(1),
});

export const progressRouter = Router();

progressRouter.use(authenticate, requirePasswordCurrent, requireRole('user'));

progressRouter.get('/', progressController.getMyProgress);

progressRouter.get(
  '/summary',
  validate(progressSummaryQuerySchema, 'query'),
  progressController.getProgressSummary,
);

/** Super-admin progress table + per-user detail. Mounted at /api/admin/progress. */
export const adminProgressRouter = Router();

adminProgressRouter.use(
  authenticate,
  requirePasswordCurrent,
  requireRole('super_admin'),
);

adminProgressRouter.get(
  '/',
  validate(adminProgressListQuerySchema, 'query'),
  progressController.listAdminProgress,
);

adminProgressRouter.get(
  '/:userId',
  validate(adminUserProgressParamsSchema, 'params'),
  progressController.getAdminUserProgress,
);
