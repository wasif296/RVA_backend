import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody } from './users.schema.js';
import * as usersService from './users.service.js';

export async function listUsers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as unknown as ListUsersQuery;
    const result = await usersService.listUsers(query);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function createUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const body = req.body as CreateUserBody;
    const result = await usersService.createUser({
      body,
      createdById: req.user.id,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function updateUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const body = req.body as UpdateUserBody;
    const user = await usersService.updateUser({
      userId: req.params.id as string,
      body,
      actorId: req.user.id,
    });
    res.json({ user });
  } catch (error) {
    next(error);
  }
}

export async function resetPassword(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await usersService.resetPassword({
      userId: req.params.id as string,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}
