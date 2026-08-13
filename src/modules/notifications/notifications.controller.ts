import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import * as notificationsService from './notifications.service.js';

export async function listNotifications(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const query = req.query as unknown as {
      unreadOnly?: boolean;
      page: number;
      limit: number;
    };
    const result = await notificationsService.listNotifications({
      userId: req.user.id,
      unreadOnly: query.unreadOnly,
      page: query.page,
      limit: query.limit,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function countUnread(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await notificationsService.countUnread(req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function markRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const notification = await notificationsService.markNotificationRead({
      userId: req.user.id,
      notificationId: req.params.id as string,
    });
    res.json({ notification });
  } catch (error) {
    next(error);
  }
}

export async function markAllRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await notificationsService.markAllNotificationsRead(req.user.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
}
