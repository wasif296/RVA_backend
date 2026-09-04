import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type { AdminProgressListQuery } from './progress.service.js';
import * as progressService from './progress.service.js';

export async function getProgressSummary(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    // Identity from the token only — ignore any client-supplied userId.
    const summary = await progressService.getProgressSummary(req.user.id);
    res.json(summary);
  } catch (error) {
    next(error);
  }
}

export async function getMyProgress(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    // Ignore ?userId= entirely — identity comes only from the token (IDOR guard).
    const detail = await progressService.getLearnerProgressDetail(req.user.id);
    res.json(detail);
  } catch (error) {
    next(error);
  }
}

export async function listAdminProgress(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as unknown as AdminProgressListQuery;
    const result = await progressService.listAdminProgress(query);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getAdminUserProgress(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = req.params.userId;
    const userId = Array.isArray(raw) ? raw[0] : raw;
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 'userId is required');
    }
    const detail = await progressService.getLearnerProgressDetail(userId);
    res.json(detail);
  } catch (error) {
    next(error);
  }
}
