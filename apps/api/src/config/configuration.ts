import { registerAs } from '@nestjs/config';

/**
 * Namespaced, typed config. These factories are the single place allowed to read
 * `process.env`; everything else injects the namespace via `@Inject(<ns>.KEY)`.
 * Values are already validated at boot by `validateEnv` (env.validation.ts).
 */

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.API_PORT ?? 3001),
  isProduction: process.env.NODE_ENV === 'production',
}));

export const sessionConfig = registerAs('session', () => ({
  secret: process.env.SESSION_SECRET as string,
  salt: process.env.SESSION_SALT as string,
}));

export const s3Config = registerAs('s3', () => ({
  bucket: process.env.S3_BUCKET ?? 'masternova-media',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY as string,
  secretKey: process.env.S3_SECRET_KEY as string,
  endpoint: process.env.S3_ENDPOINT as string,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? (process.env.S3_ENDPOINT as string),
}));

export const redisConfig = registerAs('redis', () => {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    url: url.toString(),
    host: url.hostname,
    port: Number(url.port || 6379),
  };
});

export const googleConfig = registerAs('google', () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackUrl:
    process.env.GOOGLE_CALLBACK_URL ?? 'http://localhost:3000/api/auth/google/callback',
  enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
}));

export type AppConfig = ReturnType<typeof appConfig>;
export type SessionConfig = ReturnType<typeof sessionConfig>;
export type S3Config = ReturnType<typeof s3Config>;
export type RedisConfig = ReturnType<typeof redisConfig>;
export type GoogleConfig = ReturnType<typeof googleConfig>;
