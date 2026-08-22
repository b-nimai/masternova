import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Session cookie (see main.ts): the key is derived from SESSION_SECRET (>=32 chars)
  // and a fixed 16-char SESSION_SALT.
  SESSION_SECRET: z.string().min(32),
  SESSION_SALT: z.string().length(16),

  // S3 / MinIO storage. S3_PUBLIC_ENDPOINT is the browser-reachable host for presigned
  // URLs; falls back to S3_ENDPOINT in the config layer when unset.
  S3_BUCKET: z.string().default('masternova-media'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),

  // Google OAuth is opt-in: only wired when both id and secret are present.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:3000/api/auth/google/callback'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
