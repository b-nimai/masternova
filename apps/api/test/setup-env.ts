/**
 * Runs before any module is imported.
 *
 * `ConfigModule.forRoot({ validate })` is evaluated when `app.module.ts` is *imported*,
 * not when the testing module compiles — so setting these inside `beforeAll` is already
 * too late and the whole suite fails on env validation. A `setupFiles` entry is the only
 * hook that runs early enough.
 *
 * DATABASE_URL only has to satisfy the schema: every suite overrides PrismaService with a
 * client pointed at its own Testcontainer.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-characters';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_ACCESS_KEY ??= 'minioadmin';
process.env.S3_SECRET_KEY ??= 'minioadmin';
process.env.GOOGLE_CALLBACK_URL ??= 'http://localhost:3000/api/auth/google/callback';
process.env.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret-at-least-32-chars';
