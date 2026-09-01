import argon2 from 'argon2';
import type { Response } from 'express';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { User } from '../../models/User.js';
import type { AuthUser } from '../../types/express.js';
import { AppError } from '../../utils/AppError.js';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
  buildRefreshCookieValue,
  generateRefreshSecret,
  hashRefreshSecret,
  parseRefreshCookieValue,
  signAccessToken,
  verifyRefreshSecret,
} from '../../utils/tokens.js';
import { listBadgesForUser, type BadgeDto } from '../grading/grading.service.js';
import { findValidInviteToken } from './inviteToken.service.js';

const GENERIC_CREDENTIALS_MESSAGE = 'Invalid email or password';
const GENERIC_INVITE_MESSAGE = 'This link is invalid or has expired';

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: AuthUser['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  totalPoints: number;
  badges: BadgeDto[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

async function toPublicUser(user: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: AuthUser['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  totalPoints: number;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}): Promise<PublicUser> {
  const badges = await listBadgesForUser(user._id.toString());
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    totalPoints: user.totalPoints,
    badges,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function refreshCookieOptions(): {
  httpOnly: true;
  sameSite: 'none' | 'strict';
  secure: boolean;
  path: '/api/auth';
  maxAge?: number;
} {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    // Cross-origin deploy (Vercel frontend + Vercel backend on different
    // domains): SameSite=Strict silently drops the refresh cookie on every
    // credentialed request, so token refresh fails with no obvious error.
    // None+Secure is required for cross-site cookies. Keep Strict in
    // development where the Vite proxy keeps /api same-site.
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
    path: '/api/auth',
  };
}

function setRefreshCookie(res: Response, cookieValue: string): void {
  res.cookie(REFRESH_COOKIE_NAME, cookieValue, {
    ...refreshCookieOptions(),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
}

async function issueRefreshToken(params: {
  userId: Types.ObjectId;
  userAgent?: string;
  replacedFromId?: Types.ObjectId;
}): Promise<string> {
  const secret = generateRefreshSecret();
  const tokenHash = await hashRefreshSecret(secret);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const created = await RefreshToken.create({
    userId: params.userId,
    tokenHash,
    expiresAt,
    userAgent: params.userAgent,
  });

  if (params.replacedFromId) {
    await RefreshToken.findByIdAndUpdate(params.replacedFromId, {
      replacedBy: created._id,
    });
  }

  return buildRefreshCookieValue(created._id.toString(), secret);
}

async function revokeAllUserRefreshTokens(userId: Types.ObjectId): Promise<void> {
  await RefreshToken.updateMany({ userId }, { $set: { revokedAt: new Date() } });
}

export async function login(params: {
  email: string;
  password: string;
  userAgent?: string;
  res: Response;
}): Promise<{ user: PublicUser; accessToken: string }> {
  const user = await User.findOne({ email: params.email }).select('+passwordHash');

  if (!user?.passwordHash || !user.isActive) {
    throw new AppError('INVALID_CREDENTIALS', GENERIC_CREDENTIALS_MESSAGE);
  }

  const valid = await argon2.verify(user.passwordHash, params.password);
  if (!valid) {
    throw new AppError('INVALID_CREDENTIALS', GENERIC_CREDENTIALS_MESSAGE);
  }

  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  const cookieValue = await issueRefreshToken({
    userId: user._id,
    userAgent: params.userAgent,
  });
  setRefreshCookie(params.res, cookieValue);

  return { user: await toPublicUser(user), accessToken };
}

export async function refresh(params: {
  cookieValue?: string;
  userAgent?: string;
  res: Response;
}): Promise<{ accessToken: string }> {
  if (!params.cookieValue) {
    throw new AppError('UNAUTHENTICATED', 'Refresh token required');
  }

  const parsed = parseRefreshCookieValue(params.cookieValue);
  if (!parsed || !Types.ObjectId.isValid(parsed.tokenId)) {
    throw new AppError('UNAUTHENTICATED', 'Invalid refresh token');
  }

  const existing = await RefreshToken.findById(parsed.tokenId);
  if (!existing) {
    throw new AppError('UNAUTHENTICATED', 'Invalid refresh token');
  }

  const secretOk = await verifyRefreshSecret(existing.tokenHash, parsed.secret);
  if (!secretOk) {
    throw new AppError('UNAUTHENTICATED', 'Invalid refresh token');
  }

  if (existing.revokedAt) {
    await revokeAllUserRefreshTokens(existing.userId);
    clearRefreshCookie(params.res);
    throw new AppError('UNAUTHENTICATED', 'Refresh token reuse detected');
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    existing.revokedAt = new Date();
    await existing.save();
    clearRefreshCookie(params.res);
    throw new AppError('UNAUTHENTICATED', 'Refresh token expired');
  }

  const user = await User.findById(existing.userId);
  if (!user || !user.isActive) {
    await revokeAllUserRefreshTokens(existing.userId);
    clearRefreshCookie(params.res);
    throw new AppError('UNAUTHENTICATED', 'Invalid refresh token');
  }

  existing.revokedAt = new Date();
  await existing.save();

  const cookieValue = await issueRefreshToken({
    userId: user._id,
    userAgent: params.userAgent,
    replacedFromId: existing._id,
  });
  setRefreshCookie(params.res, cookieValue);

  const accessToken = signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  return { accessToken };
}

export async function logout(params: {
  userId: string;
  cookieValue?: string;
  res: Response;
}): Promise<void> {
  if (params.cookieValue) {
    const parsed = parseRefreshCookieValue(params.cookieValue);
    if (parsed && Types.ObjectId.isValid(parsed.tokenId)) {
      const existing = await RefreshToken.findById(parsed.tokenId);
      if (
        existing &&
        existing.userId.toString() === params.userId &&
        (await verifyRefreshSecret(existing.tokenHash, parsed.secret))
      ) {
        existing.revokedAt = new Date();
        await existing.save();
      }
    }
  }

  clearRefreshCookie(params.res);
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return await toPublicUser(user);
}

export async function changePassword(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  res: Response;
}): Promise<void> {
  const user = await User.findById(params.userId).select('+passwordHash');
  if (!user?.passwordHash || !user.isActive) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }

  const valid = await argon2.verify(user.passwordHash, params.currentPassword);
  if (!valid) {
    throw new AppError('INVALID_CREDENTIALS', GENERIC_CREDENTIALS_MESSAGE);
  }

  user.passwordHash = await argon2.hash(params.newPassword, {
    type: argon2.argon2id,
  });
  user.mustChangePassword = false;
  user.tokenVersion += 1;
  await user.save();

  await revokeAllUserRefreshTokens(user._id);
  clearRefreshCookie(params.res);
}

export async function getInviteInfo(token: string): Promise<{ name: string; email: string }> {
  const tokenDoc = await findValidInviteToken(token);
  if (!tokenDoc) {
    throw new AppError('INVALID_INVITE_TOKEN', GENERIC_INVITE_MESSAGE);
  }

  const user = await User.findById(tokenDoc.userId);
  if (!user || !user.isActive) {
    throw new AppError('INVALID_INVITE_TOKEN', GENERIC_INVITE_MESSAGE);
  }

  return { name: user.name, email: user.email };
}

export async function acceptInvite(params: {
  token: string;
  password: string;
  userAgent?: string;
  res: Response;
}): Promise<{ user: PublicUser; accessToken: string }> {
  const tokenDoc = await findValidInviteToken(params.token);
  if (!tokenDoc) {
    throw new AppError('INVALID_INVITE_TOKEN', GENERIC_INVITE_MESSAGE);
  }

  const user = await User.findById(tokenDoc.userId).select('+passwordHash');
  if (!user || !user.isActive) {
    throw new AppError('INVALID_INVITE_TOKEN', GENERIC_INVITE_MESSAGE);
  }

  user.passwordHash = await argon2.hash(params.password, { type: argon2.argon2id });
  user.mustChangePassword = false;
  user.tokenVersion += 1;
  user.lastLoginAt = new Date();
  await user.save();
  await revokeAllUserRefreshTokens(user._id);

  tokenDoc.usedAt = new Date();
  await tokenDoc.save();

  const accessToken = signAccessToken({
    sub: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  const cookieValue = await issueRefreshToken({
    userId: user._id,
    userAgent: params.userAgent,
  });
  setRefreshCookie(params.res, cookieValue);

  return { user: await toPublicUser(user), accessToken };
}
