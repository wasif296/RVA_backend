import type { NextFunction, Request, Response } from 'express';
import type { UpsertFinalExamBody, UpsertQuizBody } from './quiz.schema.js';
import * as quizService from './quiz.service.js';

export async function getLessonQuizAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quiz = await quizService.getLessonQuizForAdmin(req.params.lessonId as string);
    res.json({ quiz });
  } catch (error) {
    next(error);
  }
}

export async function upsertLessonQuiz(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await quizService.upsertLessonQuiz({
      lessonId: req.params.lessonId as string,
      body: req.body as UpsertQuizBody,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function deleteLessonQuiz(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await quizService.deleteLessonQuiz(req.params.lessonId as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function getFinalExamAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const exam = await quizService.getFinalExamForAdmin(req.params.courseId as string);
    res.json({ exam });
  } catch (error) {
    next(error);
  }
}

export async function upsertFinalExam(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await quizService.upsertFinalExam({
      courseId: req.params.courseId as string,
      body: req.body as UpsertFinalExamBody,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function deleteFinalExam(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await quizService.deleteFinalExam(req.params.courseId as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
