import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { resendInviteRateLimiter } from '../../middleware/rateLimit.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as usersController from './users.controller.js';
import {
  createUserBodySchema,
  listUsersQuerySchema,
  updateUserBodySchema,
  userIdParamsSchema,
} from './users.schema.js';

export const usersRouter = Router();

usersRouter.use(authenticate, requireRole('super_admin'), requirePasswordCurrent);

usersRouter.get('/', validate(listUsersQuerySchema, 'query'), usersController.listUsers);

usersRouter.post('/', validate(createUserBodySchema, 'body'), usersController.createUser);

usersRouter.patch(
  '/:id',
  validate(userIdParamsSchema, 'params'),
  validate(updateUserBodySchema, 'body'),
  usersController.updateUser,
);

usersRouter.delete(
  '/:id',
  validate(userIdParamsSchema, 'params'),
  usersController.deleteUser,
);

usersRouter.post(
  '/:id/reset-password',
  validate(userIdParamsSchema, 'params'),
  usersController.resetPassword,
);

usersRouter.post(
  '/:id/resend-invite',
  resendInviteRateLimiter,
  validate(userIdParamsSchema, 'params'),
  usersController.resendInvite,
);
