import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Phase 0 task 0.10 — the harness proof.
 *
 * This test asserts nothing about Masternova. It exists to prove the integration-test
 * mechanism itself works: real containers start, accept connections, and stop. Every
 * later integration test (repositories, transactions, outbox, idempotency) depends on
 * this working, so it is worth having one test whose only job is to fail loudly when
 * the harness breaks.
 *
 * The Postgres image is the pgvector build, matching docker-compose and production, so
 * an extension-dependent migration fails here rather than in a deploy.
 */
describe('testcontainers harness', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg16').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it('starts a Postgres that reports a connection URI', () => {
    expect(postgres.getConnectionUri()).toMatch(/^postgres(ql)?:\/\//);
  });

  it('starts a Redis on a mapped port', () => {
    expect(redis.getMappedPort(6379)).toBeGreaterThan(0);
  });
});
