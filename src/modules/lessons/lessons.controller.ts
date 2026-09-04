import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type {
  CreateLessonBody,
  ReorderLessonsBody,
  UpdateLessonBody,
} from './lessons.schema.js';
import * as lessonsService from './lessons.service.js';

export async function listLessons(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const lessons = await lessonsService.listLessons(req.params.courseId as string);
    res.json({ lessons });
  } catch (error) {
    next(error);
  }
}

export async function getLesson(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    const detail = await lessonsService.getLessonLearningDetail({
      lessonId: req.params.id as string,
      userId: req.user.id,
    });
    res.json(detail);
  } catch (error) {
    next(error);
  }
}

export async function createLesson(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const lesson = await lessonsService.createLesson({
      courseId: req.params.courseId as string,
      body: req.body as CreateLessonBody,
    });
    res.status(201).json({ lesson });
  } catch (error) {
    next(error);
  }
}

export async function updateLesson(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const lesson = await lessonsService.updateLesson({
      lessonId: req.params.id as string,
      body: req.body as UpdateLessonBody,
    });
    res.json({ lesson });
  } catch (error) {
    next(error);
  }
}

export async function deleteLesson(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await lessonsService.deleteLesson(req.params.id as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function reorderLessons(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const lessons = await lessonsService.reorderLessons({
      courseId: req.params.courseId as string,
      body: req.body as ReorderLessonsBody,
    });
    res.json({ lessons });
  } catch (error) {
    next(error);
  }
}
