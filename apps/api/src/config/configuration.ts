import { registerAs } from '@nestjs/config';

/**
 * Namespaced, typed config. These factories are the single place allowed to read
 * `process.env`; everything else injects the namespace via `@Inject(<ns>.KEY)`.
 * Values are already validated at boot by `validateEnv` (env.validation.ts).
 */

export const appConfig = registerAs('app', () => ({
  cookieSecret: process.env.COOKIE_SECRET as string,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.API_PORT ?? 3001),
  isProduction: process.env.NODE_ENV === 'production',
  /**
   * Believe `X-Forwarded-For`. Read at bootstrap, before the DI container exists, so it is
   * the one value `main.ts` takes from here directly.
   *
   * Without it Fastify reports the *immediate peer*, which behind a load balancer is the
   * load balancer — so `PLAYBACK_TOKEN_BIND_IP` would bind every token in the fleet to one
   * address and block nobody, while reading in the config as though it protected something.
   */
  trustProxy: process.env.TRUST_PROXY === 'true',
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
  callbackUrl: process.env.GOOGLE_CALLBACK_URL ?? 'http://localhost:3000/api/auth/google/callback',
  enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
}));

export type AppConfig = ReturnType<typeof appConfig>;
export type S3Config = ReturnType<typeof s3Config>;
export type RedisConfig = ReturnType<typeof redisConfig>;
export type GoogleConfig = ReturnType<typeof googleConfig>;

/**
 * Identity config.
 *
 * The access-token TTL is the revocation window: a JWT cannot be withdrawn before it
 * expires, so 15 minutes is the length of time a revoked session keeps working. Chosen
 * over an opaque token with a Redis lookup on every request — see ADR-0010.
 */
export const identityConfig = registerAs('identity', () => ({
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET as string,
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  emailVerificationTtlHours: Number(process.env.EMAIL_VERIFICATION_TTL_HOURS ?? 24),
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30),

  /**
   * argon2id parameters, stated explicitly rather than taken from library defaults —
   * defaults drift between versions and "I used the defaults" is not an answer. These
   * are the OWASP Password Storage Cheat Sheet's second recommended option
   * (19 MiB, t=2, p=1), which costs roughly 50ms per hash on the API's instance size.
   */
  argon2: {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  },
}));

export type IdentityConfig = ReturnType<typeof identityConfig>;

/**
 * Notification config (task 1.3), API half.
 *
 * The API never sends email — the worker does. What it needs is the key that verifies an
 * unsubscribe link the worker minted, and the secret that proves a bounce webhook really
 * came from the provider.
 */
export const notificationConfig = registerAs('notification', () => ({
  /** Must be byte-identical to the worker's, or every unsubscribe link fails to verify. */
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET as string,
  /**
   * Resend signs webhooks with a Svix-style HMAC. Optional because the local stack has no
   * provider to receive webhooks from — but when it is absent the endpoint refuses every
   * request rather than trusting the caller. Unverified is not the same as unconfigured.
   */
  webhookSecret: process.env.MAIL_WEBHOOK_SECRET,
}));

export type NotificationConfig = ReturnType<typeof notificationConfig>;

/**
 * Entitlement config (task 1.8).
 *
 * **The TTL is the whole security argument.** A playback token is the only credential that
 * travels in a URL, where it lands in browser history, in `Referer` headers and in every
 * CDN access log. Five minutes is short enough that a leaked manifest URL is worthless
 * before anyone can pass it on, and long enough that no legitimate player has to re-ask
 * mid-segment. See ADR-0019.
 */
export const entitlementConfig = registerAs('entitlement', () => ({
  playbackTokenSecret: process.env.PLAYBACK_TOKEN_SECRET as string,
  playbackTokenTtlSeconds: Number(process.env.PLAYBACK_TOKEN_TTL_SECONDS ?? 300),
  bindTokenToIp: process.env.PLAYBACK_TOKEN_BIND_IP === 'true',
}));

export type EntitlementConfig = ReturnType<typeof entitlementConfig>;

/**
 * Commerce config (task 1.9).
 *
 * Every provider credential is optional, and that is a deliberate asymmetry: a paid
 * checkout without them fails loudly at the call, while a **free** course still checks out,
 * because that path never reaches a provider. It means the whole local stack — cart,
 * coupons, the order state machine, entitlement granting — is exercisable with no Razorpay
 * account, which is the difference between a checkout flow that gets tested and one that
 * does not.
 */
export const commerceConfig = registerAs('commerce', () => ({
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
  /** Absent means the webhook endpoint refuses everything rather than trusting the caller. */
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  providerTimeoutMs: Number(process.env.PAYMENT_PROVIDER_TIMEOUT_MS ?? 10_000),
  orderExpiryMinutes: Number(process.env.ORDER_EXPIRY_MINUTES ?? 30),
  configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
}));

export type CommerceConfig = ReturnType<typeof commerceConfig>;
