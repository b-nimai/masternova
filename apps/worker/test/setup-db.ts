import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@masternova/db';

/**
 * Spins up a real Postgres and applies the real migrations.
 *
 * `migrate deploy` rather than `db push`: the point of an integration test is to exercise
 * what production will run, and that includes the migration history. A `db push` schema
 * can pass a test that a real deploy would fail.
 */
export async function startDatabase(): Promise<{
  container: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  url: string;
}> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const url = container.getConnectionUri();

  execSync('pnpm --filter @masternova/db exec prisma migrate deploy', {
    cwd: `${__dirname}/../../..`,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  return { container, prisma, url };
}
