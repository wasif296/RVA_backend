import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as notificationsController from './notifications.controller.js';

const listQuerySchema = z.object({
  unreadOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((value) => value === true || value === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamsSchema = z.object({
  id: z.string().min(1),
});

/** Mounted at /api/notifications — learner and admin (own data only). */
export const notificationsRouter = Router();

notificationsRouter.use(
  authenticate,
  requirePasswordCurrent,
  requireRole('user', 'super_admin'),
);

notificationsRouter.get(
  '/',
  validate(listQuerySchema, 'query'),
  notificationsController.listNotifications,
);

notificationsRouter.get('/count', notificationsController.countUnread);

notificationsRouter.patch('/read-all', notificationsController.markAllRead);

notificationsRouter.patch(
  '/:id/read',
  validate(idParamsSchema, 'params'),
  notificationsController.markRead,
);
