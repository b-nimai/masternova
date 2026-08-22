import { Body, Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient } from '@masternova/db';
import { IdempotencyInterceptor } from '../src/common/interceptors/idempotency.interceptor';
import { Idempotent } from '../src/common/decorators/idempotent.decorator';
import { PrismaService } from '../src/prisma/prisma.service';
import { startDatabase } from './setup-db';

/** Stands in for a charge: counts how many times the work actually happened. */
let executions = 0;

@Controller('test')
class ChargeController {
  @Post('charge')
  @Idempotent()
  charge(@Body() body: { amount: number }) {
    executions += 1;
    return { chargeId: `chg_${executions}`, amount: body.amount };
  }

  @Post('free')
  free() {
    executions += 1;
    return { ok: true };
  }
}

describe('IdempotencyInterceptor (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let app: NestFastifyApplication;

  const post = (body: object | string, key?: string) =>
    app.inject({
      method: 'POST',
      url: '/test/charge',
      headers: key ? { 'idempotency-key': key } : {},
      payload: body,
    });

  beforeAll(async () => {
    ({ container, prisma } = await startDatabase());

    const moduleRef = await Test.createTestingModule({
      controllers: [ChargeController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    executions = 0;
    await prisma.idempotencyRecord.deleteMany();
  });

  it('rejects a marked endpoint called without a key', async () => {
    const res = await post({ amount: 100 });
    expect(res.statusCode).toBe(400);
    expect(executions).toBe(0);
  });

  it('leaves unmarked endpoints alone', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/free', payload: {} });
    expect(res.statusCode).toBe(201);
    expect(executions).toBe(1);
  });

  it('executes once and replays the stored response on retry', async () => {
    const first = await post({ amount: 4999 }, 'key-1');
    const second = await post({ amount: 4999 }, 'key-1');

    expect(first.statusCode).toBe(201);
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    expect(executions).toBe(1);
  });

  /** The property that matters: a retry storm must not become a charge storm. */
  it('charges exactly once under 50 concurrent replays of the same key', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => post({ amount: 4999 }, 'key-storm')),
    );

    expect(executions).toBe(1);

    const ok = responses.filter((r) => r.statusCode === 201);
    const inFlight = responses.filter((r) => r.statusCode === 409);
    // Every response is either the real one, a replay of it, or an honest
    // "still in progress" — never a second charge.
    expect(ok.length + inFlight.length).toBe(50);
    expect(await prisma.idempotencyRecord.count()).toBe(1);
  });

  it('rejects the same key reused with a different body', async () => {
    await post({ amount: 4999 }, 'key-2');
    const res = await post({ amount: 999_999 }, 'key-2');

    expect(res.statusCode).toBe(422);
    expect(executions).toBe(1);
  });

  it("scopes keys per caller, so one caller cannot read another's response", async () => {
    await post({ amount: 4999 }, 'shared-key');
    const record = await prisma.idempotencyRecord.findFirstOrThrow();
    expect(record.scope).toMatch(/^anon:/);
    expect(record.scope).not.toBe('shared-key');
  });

  it('releases the key when the handler fails, so the client can genuinely retry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/charge',
      headers: { 'idempotency-key': 'key-fail' },
      payload: 'not json',
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // Give the fire-and-forget cleanup a tick to land.
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });
});
