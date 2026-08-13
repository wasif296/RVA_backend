import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type { SubmitFinalExamBody, SubmitQuizBody } from './quiz-taking.schema.js';
import * as quizTakingService from './quiz-taking.service.js';

export async function getLessonQuiz(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await quizTakingService.getLessonQuizForLearner({
      lessonId: req.params.lessonId as string,
      userId: req.user.id,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function submitLessonQuiz(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const body = req.body as SubmitQuizBody;
    const result = await quizTakingService.submitLessonQuiz({
      userId: req.user.id,
      lessonId: req.params.lessonId as string,
      answers: body.answers,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function listLessonAttempts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await quizTakingService.listLessonQuizAttempts({
      userId: req.user.id,
      lessonId: req.params.lessonId as string,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getFinalExam(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await quizTakingService.getFinalExamForLearner(
      req.params.courseId as string,
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function submitFinalExam(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const body = req.body as SubmitFinalExamBody;
    const result = await quizTakingService.submitFinalExam({
      userId: req.user.id,
      courseId: req.params.courseId as string,
      docUrl: body.docUrl,
      loomUrl: body.loomUrl,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getFinalExamSubmission(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await quizTakingService.getFinalExamSubmission({
      userId: req.user.id,
      courseId: req.params.courseId as string,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}
