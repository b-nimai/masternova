import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  /// Signs cookies so tampering is detectable. Not encryption — nothing secret is
  /// stored in a cookie value; the access token is itself signed and the refresh token
  /// is an opaque lookup key.
  COOKIE_SECRET: z.string().min(32),

  // S3 / MinIO storage. S3_PUBLIC_ENDPOINT is the browser-reachable host for presigned
  // URLs; falls back to S3_ENDPOINT in the config layer when unset.
  S3_BUCKET: z.string().default('masternova-media'),

  // --- identity ---
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),

  // --- notification (task 1.3) ---
  // Shared with the worker, which mints the unsubscribe links this app verifies. A
  // mismatch is silent from the API's side: every link simply fails to verify.
  UNSUBSCRIBE_SECRET: z.string().min(32),
  // Absent means the bounce webhook rejects everything rather than trusting the caller.
  MAIL_WEBHOOK_SECRET: z.string().optional(),

  // Whether to believe `X-Forwarded-For`. **Only ever true behind a proxy we control** —
  // trusting the header when nothing strips it lets any client claim any address, which
  // would defeat the very binding it exists to enable. On behind the ALB (task 2.6), off
  // on a laptop.
  TRUST_PROXY: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  // --- entitlement (task 1.8) ---
  // Signs playback tokens. Its own secret rather than reusing JWT_ACCESS_SECRET, because
  // the two have different blast radii: a leaked playback secret mints five-minute grants
  // for one lecture, a leaked access secret mints sessions. Rotating one must not rotate
  // the other.
  PLAYBACK_TOKEN_SECRET: z.string().min(32),
  PLAYBACK_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  // Off in dev, where a laptop, a container and a proxy all present different addresses
  // for the same user and the binding would reject every legitimate token.
  PLAYBACK_TOKEN_BIND_IP: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  // Google OAuth is opt-in: only wired when both id and secret are present.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:3000/api/auth/google/callback'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
