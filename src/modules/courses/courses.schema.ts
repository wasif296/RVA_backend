import { z } from 'zod';
import { env } from '../../config/env.js';

function isAllowedThumbnailUrl(value: string): boolean {
  if (value.startsWith('javascript:') || value.startsWith('data:')) {
    return false;
  }

  if (value.startsWith('https://')) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  // Local upload paths under the configured public base (e.g. /uploads/…).
  const base = env.PUBLIC_UPLOAD_BASE_URL.replace(/\/$/, '');
  if (!value.startsWith(`${base}/`)) {
    return false;
  }

  // Path traversal / odd schemes must never slip into an img src.
  if (
    value.includes('..') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('://')
  ) {
    return false;
  }

  return true;
}

const thumbnailUrl = z
  .string()
  .trim()
  .min(1)
  .refine(isAllowedThumbnailUrl, {
    message:
      'thumbnailUrl must be an https URL or a path under the configured upload base',
  });

const thumbnailPublicId = z.string().trim().min(1).max(255);

export const listCoursesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  category: z.string().trim().optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
});

export const courseIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const createCourseBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1),
  thumbnailUrl: thumbnailUrl.optional(),
  thumbnailPublicId: thumbnailPublicId.optional(),
  category: z.string().trim().min(1).max(120),
  level: z.enum(['beginner', 'intermediate', 'advanced']),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
});

export const updateCourseBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).optional(),
    thumbnailUrl: thumbnailUrl.nullable().optional(),
    thumbnailPublicId: thumbnailPublicId.nullable().optional(),
    category: z.string().trim().min(1).max(120).optional(),
    level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.thumbnailUrl !== undefined ||
      value.thumbnailPublicId !== undefined ||
      value.category !== undefined ||
      value.level !== undefined ||
      value.status !== undefined,
    { message: 'At least one field is required' },
  );

export type ListCoursesQuery = z.infer<typeof listCoursesQuerySchema>;
export type CreateCourseBody = z.infer<typeof createCourseBodySchema>;
export type UpdateCourseBody = z.infer<typeof updateCourseBodySchema>;
