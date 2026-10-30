import type { NextFunction, Request, Response } from 'express';
import { User } from '../models/User.js';
import type { AuthUser } from '../types/express.js';
import { AppError } from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/tokens.js';

function toAuthUser(user: {
  _id: { toString(): string };
  name: string;
  email: string;
  role: AuthUser['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  totalPoints: number;
  tokenVersion: number;
}): AuthUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    totalPoints: user.totalPoints,
    tokenVersion: user.tokenVersion,
  };
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    req.user = toAuthUser(user);
    next();
  } catch (error) {
    next(error);
  }
}
