import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import type { Role } from '../shared/index.js';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';

export const ACCESS_TOKEN_EXPIRES_IN = '15m';
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_COOKIE_NAME = 'refreshToken';

export type AccessTokenPayload = {
  sub: string;
  role: Role;
  tokenVersion: number;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof decoded.sub !== 'string' ||
      typeof decoded.role !== 'string' ||
      typeof decoded.tokenVersion !== 'number'
    ) {
      throw new AppError('UNAUTHENTICATED', 'Invalid access token');
    }

    return {
      sub: decoded.sub,
      role: decoded.role as Role,
      tokenVersion: decoded.tokenVersion,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('TOKEN_EXPIRED', 'Access token expired');
    }
    throw new AppError('UNAUTHENTICATED', 'Invalid access token');
  }
}

export function generateRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashRefreshSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

export async function verifyRefreshSecret(
  hash: string,
  secret: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

export function generateInviteToken(): string {
  return randomBytes(32).toString('hex');
}

export async function hashInviteToken(token: string): Promise<string> {
  return argon2.hash(token, { type: argon2.argon2id });
}

export async function verifyInviteToken(hash: string, token: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, token);
  } catch {
    return false;
  }
}

export function buildRefreshCookieValue(tokenId: string, secret: string): string {
  return `${tokenId}.${secret}`;
}

export function parseRefreshCookieValue(
  value: string,
): { tokenId: string; secret: string } | null {
  const separator = value.indexOf('.');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    tokenId: value.slice(0, separator),
    secret: value.slice(separator + 1),
  };
}
