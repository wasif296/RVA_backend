import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
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
    ),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
