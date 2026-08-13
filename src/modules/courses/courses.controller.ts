import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type { CreateCourseBody, ListCoursesQuery, UpdateCourseBody } from './courses.schema.js';
import * as coursesService from './courses.service.js';

export async function listCourses(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const result = await coursesService.listCourses({
      query: req.query as unknown as ListCoursesQuery,
      role: req.user.role,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getCourse(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }

    if (req.user.role === 'user') {
      const detail = await coursesService.getCourseDetailForLearner({
        courseId: req.params.id as string,
        userId: req.user.id,
      });
      res.json(detail);
      return;
    }

    const course = await coursesService.getCourseById({
      courseId: req.params.id as string,
      role: req.user.role,
    });
    res.json({ course });
  } catch (error) {
    next(error);
  }
}

export async function createCourse(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const course = await coursesService.createCourse({
      body: req.body as CreateCourseBody,
      createdById: req.user.id,
    });
    res.status(201).json({ course });
  } catch (error) {
    next(error);
  }
}

export async function updateCourse(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const course = await coursesService.updateCourse({
      courseId: req.params.id as string,
      body: req.body as UpdateCourseBody,
    });
    res.json({ course });
  } catch (error) {
    next(error);
  }
}

export async function deleteCourse(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await coursesService.deleteCourse({
      courseId: req.params.id as string,
    });
    if (result.archived) {
      res.json({
        course: result.course,
        message: 'Course has learner progress and was archived instead of deleted',
      });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
