import { Types, trusted } from 'mongoose';
import { env } from '../../config/env.js';
import type { Paginated } from '../../shared/index.js';
import { Badge } from '../../models/Badge.js';
import { ExamSubmission } from '../../models/ExamSubmission.js';
import { InviteToken } from '../../models/InviteToken.js';
import { Notification } from '../../models/Notification.js';
import { Progress } from '../../models/Progress.js';
import { QuizAttempt } from '../../models/QuizAttempt.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/AppError.js';
import { sendEmail, type SendEmailResult } from '../../utils/email.js';
import {
  buildInviteEmailContent,
  buildPasswordResetEmailContent,
} from '../../utils/emailTemplates.js';
import { issueInviteToken } from '../auth/inviteToken.service.js';
import type { CreateUserBody, ListUsersQuery, UpdateUserBody } from './users.schema.js';

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: 'super_admin' | 'user';
  isActive: boolean;
  /** 'pending' until the user accepts their invite and sets a password. */
  status: 'pending' | 'active';
  mustChangePassword: boolean;
  totalPoints: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserActionResult = {
  user: AdminUser;
  emailSent: boolean;
  emailError?: string;
};

function toAdminUser(user: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: 'super_admin' | 'user';
  isActive: boolean;
  passwordHash?: string;
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
    status: user.passwordHash ? 'active' : 'pending',
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

function buildInviteUrl(rawToken: string): string {
  const origin = env.APP_URL.replace(/\/$/, '');
  return `${origin}/invite/${rawToken}`;
}

async function sendUserInviteEmail(params: {
  user: { name: string; email: string };
  rawToken: string;
  invitedByName: string;
}): Promise<SendEmailResult> {
  const { subject, html, text } = buildInviteEmailContent({
    name: params.user.name,
    invitedByName: params.invitedByName,
    inviteUrl: buildInviteUrl(params.rawToken),
  });
  return sendEmail({ to: params.user.email, subject, html, text });
}

async function sendUserPasswordResetEmail(params: {
  user: { name: string; email: string };
  rawToken: string;
  invitedByName: string;
}): Promise<SendEmailResult> {
  const { subject, html, text } = buildPasswordResetEmailContent({
    name: params.user.name,
    invitedByName: params.invitedByName,
    resetUrl: buildInviteUrl(params.rawToken),
  });
  return sendEmail({ to: params.user.email, subject, html, text });
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
    User.find(filter).select('+passwordHash').sort({ createdAt: -1 }).skip(skip).limit(query.limit),
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
  createdByName: string;
}): Promise<UserActionResult> {
  const existing = await User.findOne({ email: params.body.email });
  if (existing) {
    throw new AppError('VALIDATION_ERROR', 'A user with this email already exists');
  }

  let user;
  try {
    user = await User.create({
      name: params.body.name,
      email: params.body.email,
      role: params.body.role,
      createdBy: new Types.ObjectId(params.createdById),
    });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      throw new AppError('VALIDATION_ERROR', 'A user with this email already exists');
    }
    throw error;
  }

  const rawToken = await issueInviteToken({
    userId: user._id,
    purpose: 'invite',
    createdBy: new Types.ObjectId(params.createdById),
  });

  const emailResult = await sendUserInviteEmail({
    user: { name: user.name, email: user.email },
    rawToken,
    invitedByName: params.createdByName,
  });

  return {
    user: toAdminUser(user),
    emailSent: emailResult.sent,
    ...(emailResult.sent ? {} : { emailError: emailResult.reason }),
  };
}

export async function resendInvite(params: {
  userId: string;
  createdById: string;
  createdByName: string;
}): Promise<UserActionResult> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw AppError.notFound('User not found');
  }

  const user = await User.findById(params.userId).select('+passwordHash');
  if (!user) {
    throw AppError.notFound('User not found');
  }

  const rawToken = await issueInviteToken({
    userId: user._id,
    purpose: 'invite',
    createdBy: new Types.ObjectId(params.createdById),
  });

  const emailResult = await sendUserInviteEmail({
    user: { name: user.name, email: user.email },
    rawToken,
    invitedByName: params.createdByName,
  });

  return {
    user: toAdminUser(user),
    emailSent: emailResult.sent,
    ...(emailResult.sent ? {} : { emailError: emailResult.reason }),
  };
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

  const user = await User.findById(params.userId).select('+passwordHash');
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

export async function deleteUser(params: {
  userId: string;
  actorId: string;
}): Promise<void> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw AppError.notFound('User not found');
  }

  if (params.userId === params.actorId) {
    throw new AppError('VALIDATION_ERROR', 'You cannot delete your own account');
  }

  const user = await User.findById(params.userId);
  if (!user) {
    throw AppError.notFound('User not found');
  }

  const userId = user._id;
  await Promise.all([
    Progress.deleteMany({ userId }),
    QuizAttempt.deleteMany({ userId }),
    ExamSubmission.deleteMany({ userId }),
    Badge.deleteMany({ userId }),
    RefreshToken.deleteMany({ userId }),
    InviteToken.deleteMany({ userId }),
    Notification.deleteMany({ userId }),
  ]);
  await user.deleteOne();
}

export async function resetPassword(params: {
  userId: string;
  createdById: string;
  createdByName: string;
}): Promise<UserActionResult> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw AppError.notFound('User not found');
  }

  const user = await User.findById(params.userId).select('+passwordHash');
  if (!user) {
    throw AppError.notFound('User not found');
  }

  const rawToken = await issueInviteToken({
    userId: user._id,
    purpose: 'password_reset',
    createdBy: new Types.ObjectId(params.createdById),
  });

  const emailResult = await sendUserPasswordResetEmail({
    user: { name: user.name, email: user.email },
    rawToken,
    invitedByName: params.createdByName,
  });

  return {
    user: toAdminUser(user),
    emailSent: emailResult.sent,
    ...(emailResult.sent ? {} : { emailError: emailResult.reason }),
  };
}
