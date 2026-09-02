import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // The worker persists job results, so this is required, not optional. Compose already
  // passed it in; until now nothing validated or used it (Phase 0 task 0.8).
  DATABASE_URL: z.string().url(),

  // --- notification (task 1.3) ---
  /// Which MailProvider adapter to bind. `smtp` covers Mailpit locally and SES in
  /// production; `resend` is the HTTP API. Selected here rather than inferred from
  /// NODE_ENV, so staging can point at the real provider without pretending to be prod.
  MAIL_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),
  MAIL_FROM: z.string().default('Masternova <no-reply@masternova.in>'),
  /// Replies to a transactional email go somewhere a human reads.
  MAIL_REPLY_TO: z.string().email().optional(),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /// Mailpit speaks plain SMTP on 1025; SES requires STARTTLS on 587.
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  RESEND_API_KEY: z.string().optional(),

  /// Public base URL of the web app. Every link in an email is built from it, so it is
  /// required rather than defaulted to localhost — an email that ships a localhost link
  /// to a real inbox is a bug you only find in production.
  WEB_URL: z.string().url().default('http://localhost:3000'),
  /// Publicly reachable base URL of the API. Mail providers POST the one-click
  /// unsubscribe here, so it must be reachable from outside the docker network.
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
  /// HMAC key for unsubscribe links. Rotating it invalidates every outstanding link,
  /// which is the whole revocation story for a stateless token.
  UNSUBSCRIBE_SECRET: z.string().min(32),

  // --- object storage (task 1.7) ---
  /// The transcode pipeline reads the source and writes every rendition, so these are
  /// required rather than defaulted: a worker that silently points at the wrong bucket
  /// produces renditions the API can never find, and the symptom is a lecture that
  /// finishes processing and still will not play.
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().default('masternova-media'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
