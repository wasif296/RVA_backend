import { z } from 'zod';

export const lessonIdParamsSchema = z.object({
  lessonId: z.string().min(1),
});

export const courseIdParamsSchema = z.object({
  courseId: z.string().min(1),
});

/** Selected option index, or null if unanswered. Lesson quizzes only. */
export const submitQuizBodySchema = z.object({
  answers: z.array(z.union([z.number().int(), z.null()])),
});

export type SubmitQuizBody = z.infer<typeof submitQuizBodySchema>;

const httpsUrlSchema = z
  .string()
  .trim()
  .url('Must be a valid URL')
  .refine((value) => value.toLowerCase().startsWith('https://'), {
    message: 'URL must use https',
  });

/** Written final exam submission — links only; no auto-scoring. */
export const submitFinalExamBodySchema = z.object({
  docUrl: httpsUrlSchema,
  loomUrl: httpsUrlSchema.optional().nullable(),
});

export type SubmitFinalExamBody = z.infer<typeof submitFinalExamBodySchema>;
