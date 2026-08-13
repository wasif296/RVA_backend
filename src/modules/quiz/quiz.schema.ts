import { z } from 'zod';

export const lessonIdParamsSchema = z.object({
  lessonId: z.string().min(1),
});

export const courseIdParamsSchema = z.object({
  courseId: z.string().min(1),
});

const lessonQuestionInputSchema = z
  .object({
    text: z.string().trim().min(1, 'Question text is required'),
    options: z
      .array(z.string().trim().min(1, 'Option text is required'))
      .min(2, 'Each question needs at least 2 options')
      .max(6, 'Each question may have at most 6 options'),
    correctIndex: z.number().int().min(0),
  })
  .superRefine((question, ctx) => {
    const normalized = question.options.map((option) => option.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Options within a question must be mutually distinct',
        path: ['options'],
      });
    }
    if (question.correctIndex >= question.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'correctIndex must be within the options range',
        path: ['correctIndex'],
      });
    }
  });

export const upsertQuizBodySchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    pointsPerQuestion: z.number().int().min(1).max(20),
    passingScorePct: z.number().int().min(0).max(100),
    questions: z
      .array(lessonQuestionInputSchema)
      .min(1, 'Quiz must include at least one question')
      .max(100, 'Quiz may have at most 100 questions'),
  })
  .superRefine((body, ctx) => {
    const texts = body.questions.map((question) => question.text.toLowerCase());
    if (new Set(texts).size !== texts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate question text within one quiz is not allowed',
        path: ['questions'],
      });
    }
  });

export type UpsertQuizBody = z.infer<typeof upsertQuizBodySchema>;

const examQuestionInputSchema = z.object({
  text: z.string().trim().min(1, 'Question text is required'),
});

/** Admin upsert for written final exams — text questions only. */
export const upsertFinalExamBodySchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    instructions: z.string().trim().max(10_000).default(''),
    questions: z
      .array(examQuestionInputSchema)
      .min(1, 'Exam must include at least one question')
      .max(100, 'Exam may have at most 100 questions'),
  })
  .superRefine((body, ctx) => {
    const texts = body.questions.map((question) => question.text.toLowerCase());
    if (new Set(texts).size !== texts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate question text within one exam is not allowed',
        path: ['questions'],
      });
    }
  });

export type UpsertFinalExamBody = z.infer<typeof upsertFinalExamBodySchema>;
