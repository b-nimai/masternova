import { registerAs } from '@nestjs/config';

/**
 * Namespaced, typed config. This factory is the single place allowed to read `process.env`.
 * REDIS_URL is parsed into host/port for the BullMQ connection. Values are validated at boot
 * by `validateEnv` (env.validation.ts).
 */
export const redisConfig = registerAs('redis', () => {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    url: url.toString(),
    host: url.hostname,
    port: Number(url.port || 6379),
  };
});

export type RedisConfig = ReturnType<typeof redisConfig>;

/** The worker owns persistence for job results; see PrismaModule. */
export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL as string,
}));

export type DatabaseConfig = ReturnType<typeof databaseConfig>;

/**
 * Notification config (task 1.3).
 *
 * `provider` is what `NotificationModule` switches on to bind `MAIL_PROVIDER`. That is
 * the one `switch` in the module and it is in the composition root, which is the only
 * place a switch over implementations belongs — inside a service it would be the design
 * smell CLAUDE.md §1 O warns about.
 */
export const mailConfig = registerAs('mail', () => ({
  provider: (process.env.MAIL_PROVIDER ?? 'smtp') as 'smtp' | 'resend',
  from: process.env.MAIL_FROM ?? 'Masternova <no-reply@masternova.in>',
  replyTo: process.env.MAIL_REPLY_TO,
  smtp: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY,
  },
}));

export type MailConfig = ReturnType<typeof mailConfig>;

/** Everything an email needs to build a correct link back into the product. */
export const notificationConfig = registerAs('notification', () => ({
  webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
  /// The visible footer link goes to the web app, but the RFC 8058 `List-Unsubscribe`
  /// header must point at something a mail provider can POST to unattended — that is the
  /// API, not a React page.
  apiUrl: process.env.API_PUBLIC_URL ?? 'http://localhost:3001',
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET as string,
}));

export type NotificationConfig = ReturnType<typeof notificationConfig>;

/**
 * Object storage, for the transcode pipeline (task 1.7).
 *
 * Mirrors the API's `s3Config` deliberately: the same environment variables name the same
 * bucket, because both deployables read and write the same objects. The values are handed
 * to `StorageModule.forRootAsync` — the package itself never reads `process.env` (§4).
 */
export const s3Config = registerAs('s3', () => ({
  bucket: process.env.S3_BUCKET ?? 'masternova-media',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY as string,
  secretKey: process.env.S3_SECRET_KEY as string,
  endpoint: process.env.S3_ENDPOINT as string,
  /**
   * The worker signs only server-to-server URLs, which ffmpeg fetches from inside the
   * network — so unlike the API there is no browser-facing endpoint to differ from.
   */
  publicEndpoint: process.env.S3_ENDPOINT as string,
}));

export type S3Config = ReturnType<typeof s3Config>;
