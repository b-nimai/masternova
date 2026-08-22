import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // The worker persists job results, so this is required, not optional. Compose already
  // passed it in; until now nothing validated or used it (Phase 0 task 0.8).
  DATABASE_URL: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
