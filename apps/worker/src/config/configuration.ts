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
