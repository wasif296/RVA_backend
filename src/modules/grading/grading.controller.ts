import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type {
  GradeExamSubmissionBody,
  ListExamSubmissionsQuery,
} from './grading.schema.js';
import * as gradingService from './grading.service.js';

export async function listExamSubmissions(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as unknown as ListExamSubmissionsQuery;
    const result = await gradingService.listExamSubmissions(query);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getExamSubmission(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const submission = await gradingService.getExamSubmissionDetail(
      req.params.id as string,
    );
    res.json({ submission });
  } catch (error) {
    next(error);
  }
}

export async function gradeExamSubmission(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await gradingService.gradeExamSubmission({
      submissionId: req.params.id as string,
      graderId: req.user.id,
      body: req.body as GradeExamSubmissionBody,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function listMyBadges(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const badges = await gradingService.listBadgesForUser(req.user.id);
    res.json({ badges });
  } catch (error) {
    next(error);
  }
}
