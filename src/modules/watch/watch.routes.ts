import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { heartbeatRateLimiter } from '../../middleware/rateLimit.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as watchController from './watch.controller.js';
import { heartbeatBodySchema, lessonIdParamsSchema } from './watch.schema.js';

export const watchRouter = Router();

// Auth only at router level so unmatched methods (admin PATCH/DELETE) fall through
// to lessonsRouter. requireRole('user') is per-route.
watchRouter.use(authenticate, requirePasswordCurrent);

watchRouter.post(
  '/:id/heartbeat',
  requireRole('user'),
  heartbeatRateLimiter,
  validate(lessonIdParamsSchema, 'params'),
  validate(heartbeatBodySchema, 'body'),
  watchController.postHeartbeat,
);

watchRouter.post(
  '/:id/complete-video',
  requireRole('user'),
  validate(lessonIdParamsSchema, 'params'),
  watchController.completeVideo,
);
