import type { NextFunction, Request, Response } from 'express';
import { REFRESH_COOKIE_NAME } from '../../utils/tokens.js';
import { AppError } from '../../utils/AppError.js';
import type {
  AcceptInviteBody,
  ChangePasswordBody,
  InviteTokenParams,
  LoginBody,
} from './auth.schema.js';
import * as authService from './auth.service.js';

export async function login(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as LoginBody;
    const result = await authService.login({
      email: body.email,
      password: body.password,
      userAgent: req.get('user-agent') ?? undefined,
      res,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function refresh(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cookieValue = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const result = await authService.refresh({
      cookieValue,
      userAgent: req.get('user-agent') ?? undefined,
      res,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function logout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const cookieValue = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    await authService.logout({
      userId: req.user.id,
      cookieValue,
      res,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function me(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const user = await authService.getMe(req.user.id);
    res.json({ user });
  } catch (error) {
    next(error);
  }
}

export async function changePassword(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const body = req.body as ChangePasswordBody;
    await authService.changePassword({
      userId: req.user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      res,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function getInvite(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { token } = req.params as unknown as InviteTokenParams;
    const result = await authService.getInviteInfo(token);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function acceptInvite(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { token } = req.params as unknown as InviteTokenParams;
    const body = req.body as AcceptInviteBody;
    const result = await authService.acceptInvite({
      token,
      password: body.password,
      userAgent: req.get('user-agent') ?? undefined,
      res,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}
