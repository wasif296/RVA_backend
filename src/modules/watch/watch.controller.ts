import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type { HeartbeatBody } from './watch.schema.js';
import * as watchService from './watch.service.js';

export async function postHeartbeat(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    const body = req.body as HeartbeatBody;
    const result = await watchService.postHeartbeat({
      userId: req.user.id,
      lessonId: req.params.id as string,
      deltaSec: body.deltaSec,
      playerPositionSec: body.playerPositionSec,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function completeVideo(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    const result = await watchService.completeVideo({
      userId: req.user.id,
      lessonId: req.params.id as string,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}
