import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().default(4000),
    MONGODB_URI: z.string().min(1),
    CORS_ORIGIN: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .refine((origins) => origins.length > 0, {
        message: 'CORS_ORIGIN must list at least one origin',
      })
      .refine((origins) => origins.every((origin) => origin !== '*'), {
        message:
          'CORS_ORIGIN must not use a wildcard; the refresh cookie requires an explicit allowlist',
      }),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    LOG_LEVEL: z.string().min(1),
    /** Absolute or relative path for LocalDiskAdapter storage. */
    UPLOAD_DIR: z.string().min(1).default('./uploads'),
    /** Public URL prefix for stored files, e.g. /uploads */
    PUBLIC_UPLOAD_BASE_URL: z
      .string()
      .min(1)
      .default('/uploads')
      .refine((value) => value.startsWith('/'), {
        message: 'PUBLIC_UPLOAD_BASE_URL must be a path starting with /',
      }),
    STORAGE_DRIVER: z.preprocess(
      emptyToUndefined,
      z.enum(['local', 'cloudinary']).default('local'),
    ),
    CLOUDINARY_CLOUD_NAME: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    CLOUDINARY_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    CLOUDINARY_API_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    UPSTASH_REDIS_REST_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    UPSTASH_REDIS_REST_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    /** Absent in development: email.ts logs the full message instead of sending. */
    RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    EMAIL_FROM: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    /** Frontend origin used to build invite/reset links — required in every environment. */
    APP_URL: z.string().min(1).url(),
  })
  .superRefine((data, ctx) => {
    if (data.STORAGE_DRIVER === 'cloudinary') {
      const required = [
        ['CLOUDINARY_CLOUD_NAME', data.CLOUDINARY_CLOUD_NAME],
        ['CLOUDINARY_API_KEY', data.CLOUDINARY_API_KEY],
        ['CLOUDINARY_API_SECRET', data.CLOUDINARY_API_SECRET],
      ] as const;
      for (const [name, value] of required) {
        if (!value) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required when STORAGE_DRIVER is cloudinary`,
          });
        }
      }
    }

    if (data.NODE_ENV !== 'production') return;

    if (data.STORAGE_DRIVER !== 'cloudinary') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message:
          'STORAGE_DRIVER must be cloudinary in production (Vercel filesystem is ephemeral)',
      });
    }

    if (!data.UPSTASH_REDIS_REST_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UPSTASH_REDIS_REST_URL'],
        message: 'UPSTASH_REDIS_REST_URL is required in production for shared rate limits',
      });
    }
    if (!data.UPSTASH_REDIS_REST_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UPSTASH_REDIS_REST_TOKEN'],
        message: 'UPSTASH_REDIS_REST_TOKEN is required in production for shared rate limits',
      });
    }

    if (!data.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required in production to send invite/reset emails',
      });
    }
    if (!data.EMAIL_FROM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_FROM'],
        message: 'EMAIL_FROM is required in production to send invite/reset emails',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Parse env without exiting — used by boot and tests. */
export function parseEnv(input: NodeJS.ProcessEnv = process.env) {
  return envSchema.safeParse(input);
}

const parsed = parseEnv(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
