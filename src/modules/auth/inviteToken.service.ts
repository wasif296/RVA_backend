import { Types } from 'mongoose';
import { InviteToken, type InvitePurpose } from '../../models/InviteToken.js';
import {
  generateInviteToken,
  hashInviteToken,
  verifyInviteToken,
} from '../../utils/tokens.js';

export const INVITE_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export async function issueInviteToken(params: {
  userId: Types.ObjectId;
  purpose: InvitePurpose;
  createdBy?: Types.ObjectId;
}): Promise<string> {
  // Only one outstanding token per user+purpose — a fresh invite/reset must
  // invalidate whatever link was sent before it. Equality-only filter: global
  // sanitizeFilter strips `$` operators and `{ usedAt: null }`.
  await InviteToken.deleteMany({
    userId: params.userId,
    purpose: params.purpose,
  });

  const rawToken = generateInviteToken();
  const tokenHash = await hashInviteToken(rawToken);

  await InviteToken.create({
    userId: params.userId,
    tokenHash,
    purpose: params.purpose,
    expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
    createdBy: params.createdBy,
  });

  return rawToken;
}

/**
 * tokenHash is an argon2 hash (salted, not queryable), so a raw token can
 * only be resolved by verifying it against each still-valid candidate.
 * Purpose is intentionally not filtered here — the same emailed link
 * activates either an invite or an admin-triggered password reset, and both
 * must fail with the identical generic error when invalid.
 *
 * Expiry and usedAt are filtered in JS. Global sanitizeFilter rejects
 * `{ expiresAt: { $gt } }` and is unreliable with `{ usedAt: null }`.
 */
export async function findValidInviteToken(rawToken: string) {
  const now = Date.now();
  const candidates = await InviteToken.find();

  for (const candidate of candidates) {
    if (candidate.usedAt) continue;
    if (candidate.expiresAt.getTime() <= now) continue;
    if (await verifyInviteToken(candidate.tokenHash, rawToken)) {
      return candidate;
    }
  }

  return null;
}
