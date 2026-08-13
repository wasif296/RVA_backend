import { z } from 'zod';
import { RULES } from '@shared';

export const examSubmissionIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const listExamSubmissionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Default ungraded queue — tutors grade what is waiting. */
  status: z.enum(['submitted', 'graded']).default('submitted'),
  courseId: z.string().optional(),
  search: z.string().optional(),
});

export type ListExamSubmissionsQuery = z.infer<typeof listExamSubmissionsQuerySchema>;

export const gradeExamSubmissionBodySchema = z.object({
  marksAwarded: z
    .number({
      required_error: 'marksAwarded is required',
      invalid_type_error: 'marksAwarded must be an integer',
    })
    .int('marksAwarded must be an integer')
    .min(0, `marksAwarded must be between 0 and ${RULES.FINAL_EXAM_MAX_MARKS}`)
    .max(
      RULES.FINAL_EXAM_MAX_MARKS,
      `marksAwarded must be between 0 and ${RULES.FINAL_EXAM_MAX_MARKS}`,
    ),
  feedback: z.string().trim().max(5000).optional().nullable(),
});

export type GradeExamSubmissionBody = z.infer<typeof gradeExamSubmissionBodySchema>;
