import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters');

export const loginBodySchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const inviteTokenParamsSchema = z.object({
  token: z.string().min(1),
});

export const acceptInviteBodySchema = z.object({
  password: passwordSchema,
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type InviteTokenParams = z.infer<typeof inviteTokenParamsSchema>;
export type AcceptInviteBody = z.infer<typeof acceptInviteBodySchema>;
