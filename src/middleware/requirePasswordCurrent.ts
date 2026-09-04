import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError.js';

const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED = new Set([
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
  // GET /me is not listed here — it omits this middleware in auth.routes.ts.
  // /me answers "who am I" and must return mustChangePassword to the client.
]);

export function requirePasswordCurrent(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    next(new AppError('UNAUTHENTICATED', 'Authentication required'));
    return;
  }

  if (!req.user.mustChangePassword) {
    next();
    return;
  }

  const key = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/$/, '') || `${req.method} ${req.originalUrl}`;
  const routeKey = `${req.method} ${req.originalUrl.split('?')[0]}`;

  if (
    ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.has(routeKey) ||
    ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.has(key)
  ) {
    next();
    return;
  }

  next(
    new AppError(
      'PASSWORD_CHANGE_REQUIRED',
      'Password change required before continuing',
    ),
  );
}
