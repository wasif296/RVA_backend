import argon2 from 'argon2';
import { Types, trusted } from 'mongoose';
import type { Paginated } from '@shared';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/AppError.js';
import { generatePassword } from '../../utils/generatePassword.js';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody } from './users.schema.js';

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: 'super_admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  totalPoints: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toAdminUser(user: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: 'super_admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  totalPoints: number;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}): AdminUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    totalPoints: user.totalPoints,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateEmailError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

async function revokeAllRefreshTokens(userId: Types.ObjectId): Promise<void> {
  await RefreshToken.updateMany({ userId }, { $set: { revokedAt: new Date() } });
}

export async function listUsers(query: ListUsersQuery): Promise<Paginated<AdminUser>> {
  const filter: Record<string, unknown> = {};

  if (query.role) {
    filter.role = query.role;
  }
  if (query.isActive !== undefined) {
    filter.isActive = query.isActive;
  }
  if (query.search) {
    const pattern = escapeRegex(query.search);
    // trusted() marks server-built operators so global sanitizeFilter will not strip them.
    filter.$or = trusted([
      { name: { $regex: pattern, $options: 'i' } },
      { email: { $regex: pattern, $options: 'i' } },
    ]);
  }

  const skip = (query.page - 1) * query.limit;
  const [rows, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    User.countDocuments(filter),
  ]);

  return {
    data: rows.map(toAdminUser),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
    },
  };
}

export async function createUser(params: {
  body: CreateUserBody;
  createdById: string;
}): Promise<{ user: AdminUser; temporaryPassword: string }> {
  const existing = await User.findOne({ email: params.body.email });
  if (existing) {
    throw new AppError('VALIDATION_ERROR', 'A user with this email already exists');
  }

  const temporaryPassword = generatePassword(16);
  const passwordHash = await argon2.hash(temporaryPassword, {
    type: argon2.argon2id,
  });

  try {
    const user = await User.create({
      name: params.body.name,
      email: params.body.email,
      role: params.body.role,
      passwordHash,
      mustChangePassword: true,
      createdBy: new Types.ObjectId(params.createdById),
    });

    return {
      user: toAdminUser(user),
      temporaryPassword,
    };
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      throw new AppError('VALIDATION_ERROR', 'A user with this email already exists');
    }
    throw error;
  }
}

export async function updateUser(params: {
  userId: string;
  body: UpdateUserBody;
  actorId: string;
}): Promise<AdminUser> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw AppError.notFound('User not found');
  }

  if (params.body.isActive === false && params.userId === params.actorId) {
    throw new AppError('VALIDATION_ERROR', 'You cannot deactivate your own account');
  }

  const user = await User.findById(params.userId);
  if (!user) {
    throw AppError.notFound('User not found');
  }

  if (params.body.name !== undefined) {
    user.name = params.body.name;
  }
  if (params.body.isActive !== undefined) {
    user.isActive = params.body.isActive;
    if (params.body.isActive === false) {
      user.tokenVersion += 1;
      await revokeAllRefreshTokens(user._id);
    }
  }

  await user.save();
  return toAdminUser(user);
}

export async function resetPassword(params: {
  userId: string;
}): Promise<{ user: AdminUser; temporaryPassword: string }> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw AppError.notFound('User not found');
  }

  const user = await User.findById(params.userId).select('+passwordHash');
  if (!user) {
    throw AppError.notFound('User not found');
  }

  const temporaryPassword = generatePassword(16);
  user.passwordHash = await argon2.hash(temporaryPassword, {
    type: argon2.argon2id,
  });
  user.mustChangePassword = true;
  user.tokenVersion += 1;
  await user.save();
  await revokeAllRefreshTokens(user._id);

  return {
    user: toAdminUser(user),
    temporaryPassword,
  };
}
