import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@shared';
import { AppError } from '../utils/AppError.js';

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError('UNAUTHENTICATED', 'Authentication required'));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new AppError('FORBIDDEN', 'You do not have permission to perform this action'));
      return;
    }

    next();
  };
}
