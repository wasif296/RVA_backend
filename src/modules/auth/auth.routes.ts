import { Router } from 'express';
import { env } from '../../config/env.js';
import { authenticate } from '../../middleware/authenticate.js';
import { loginRateLimiter, refreshRateLimiter } from '../../middleware/rateLimit.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import { changePasswordBodySchema, loginBodySchema } from './auth.schema.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  loginRateLimiter,
  validate(loginBodySchema, 'body'),
  authController.login,
);

authRouter.post('/refresh', refreshRateLimiter, authController.refresh);

authRouter.post(
  '/logout',
  authenticate,
  requirePasswordCurrent,
  authController.logout,
);

authRouter.get('/me', authenticate, authController.me);

authRouter.post(
  '/change-password',
  authenticate,
  requirePasswordCurrent,
  validate(changePasswordBodySchema, 'body'),
  authController.changePassword,
);

if (env.NODE_ENV === 'test') {
  authRouter.get(
    '/__test/admin',
    authenticate,
    requireRole('super_admin'),
    requirePasswordCurrent,
    (_req, res) => {
      res.json({ ok: true });
    },
  );
}
