import { z } from 'zod';

export const courseIdParamsSchema = z.object({
  courseId: z.string().min(1),
});

export const lessonIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const createLessonBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1),
  /** Bare 11-char ID or full YouTube URL — parsed server-side. */
  youtubeVideoId: z.string().trim().min(1),
  durationSec: z.number().int().min(1),
  /** Admin-only override; omitted → ceil(durationSec * 0.9). */
  requiredWatchSec: z.number().int().min(1).optional(),
  isOptional: z.boolean().optional().default(false),
});

export const updateLessonBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).optional(),
    youtubeVideoId: z.string().trim().min(1).optional(),
    durationSec: z.number().int().min(1).optional(),
    /**
     * Admin-only. A number sets an override; `null` clears the override and
     * restores ceil(durationSec * 0.9).
     */
    requiredWatchSec: z.number().int().min(1).nullable().optional(),
    isOptional: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.youtubeVideoId !== undefined ||
      value.durationSec !== undefined ||
      value.requiredWatchSec !== undefined ||
      value.isOptional !== undefined,
    { message: 'At least one field is required' },
  );

export const reorderLessonsBodySchema = z.object({
  lessonIds: z.array(z.string().min(1)).min(1),
});

export type CreateLessonBody = z.infer<typeof createLessonBodySchema>;
export type UpdateLessonBody = z.infer<typeof updateLessonBodySchema>;
export type ReorderLessonsBody = z.infer<typeof reorderLessonsBodySchema>;
