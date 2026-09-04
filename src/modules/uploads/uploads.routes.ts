import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { uploadRateLimiter } from '../../middleware/rateLimit.js';
import { requirePasswordCurrent } from '../../middleware/requirePasswordCurrent.js';
import { requireRole } from '../../middleware/requireRole.js';
import * as uploadsController from './uploads.controller.js';

export const uploadsRouter = Router();

uploadsRouter.use(
  authenticate,
  requireRole('super_admin'),
  requirePasswordCurrent,
);

function runThumbnailUpload(req: Request, res: Response, next: NextFunction): void {
  uploadsController.thumbnailUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      uploadsController.handleThumbnailMulterError(err, req, res, next);
      return;
    }
    next();
  });
}

uploadsRouter.post(
  '/thumbnail',
  uploadRateLimiter,
  runThumbnailUpload,
  uploadsController.uploadThumbnail,
);
