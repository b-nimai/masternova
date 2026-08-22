import { randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient } from '@masternova/db';
import type { DomainEventHandler } from '@masternova/contracts';
import { OutboxRelayService } from '../src/modules/outbox-relay/outbox-relay.service';
import { DomainEventDispatcher } from '../src/modules/outbox-relay/domain-event-dispatcher.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { startDatabase } from './setup-db';

/**
 * The relay's two hard claims are concurrency-safe claiming and exactly-once effects under
 * repeated delivery. Neither can be demonstrated without a real database: `FOR UPDATE SKIP
 * LOCKED` has no fake, and a fake would just agree with whatever we asserted.
 */
describe('OutboxRelayService (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  const seed = (over: Partial<{ type: string; availableAt: Date; attempts: number }> = {}) =>
    prisma.outboxMessage.create({
      data: {
        eventId: randomUUID(),
        type: over.type ?? 'commerce.order.paid',
        aggregateType: 'Order',
        aggregateId: randomUUID(),
        payload: { total: 4999 },
        availableAt: over.availableAt ?? new Date(),
        attempts: over.attempts ?? 0,
      },
    });

  const relayWith = (handlers: DomainEventHandler[]) => {
    const p = prisma as unknown as PrismaService;
    return new OutboxRelayService(p, new DomainEventDispatcher(p, handlers));
  };

  const counting = (name: string, impl?: () => Promise<void>) => {
    const h = {
      name,
      eventType: 'commerce.order.paid',
      calls: 0,
      async handle() {
        h.calls += 1;
        if (impl) await impl();
      },
    };
    return h;
  };

  beforeAll(async () => {
    ({ container, prisma } = await startDatabase());
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.processedEvent.deleteMany();
    await prisma.outboxMessage.deleteMany();
  });

  it('delivers a pending message and marks it published', async () => {
    await seed();
    const handler = counting('enroll');

    await relayWith([handler]).tick();

    expect(handler.calls).toBe(1);
    const [msg] = await prisma.outboxMessage.findMany();
    expect(msg.status).toBe('PUBLISHED');
    expect(msg.publishedAt).not.toBeNull();
    expect(msg.attempts).toBe(1);
  });

  it('leaves a message that is not yet due', async () => {
    await seed({ availableAt: new Date(Date.now() + 60_000) });
    const handler = counting('enroll');

    await relayWith([handler]).tick();

    expect(handler.calls).toBe(0);
    expect((await prisma.outboxMessage.findFirst())?.status).toBe('PENDING');
  });

  /**
   * The load-bearing test for `FOR UPDATE SKIP LOCKED`. Ten relays polling the same table
   * at the same time must between them deliver each message exactly once. Without SKIP
   * LOCKED they serialise; without FOR UPDATE they collide and every effect happens N times.
   */
  it('never double-delivers when many relays poll concurrently', async () => {
    const MESSAGES = 40;
    const RELAYS = 10;
    await Promise.all(Array.from({ length: MESSAGES }, () => seed()));

    const handlers = Array.from({ length: RELAYS }, (_, i) => counting(`h-${i}`));
    // Every relay shares one handler name, so a double-claim would show up as a
    // second call for the same (event, handler) pair.
    const shared = counting('enroll');
    const relays = handlers.map(() => relayWith([shared]));

    await Promise.all(relays.map((r) => r.tick()));

    expect(shared.calls).toBe(MESSAGES);
    const statuses = await prisma.outboxMessage.groupBy({
      by: ['status'],
      _count: true,
    });
    expect(statuses).toEqual([{ status: 'PUBLISHED', _count: MESSAGES }]);
  });

  it('backs off and stays retryable when a handler fails', async () => {
    await seed();
    const before = Date.now();

    await relayWith([
      counting('broken', async () => {
        throw new Error('smtp down');
      }),
    ]).tick();

    const msg = await prisma.outboxMessage.findFirstOrThrow();
    expect(msg.status).toBe('PENDING');
    expect(msg.attempts).toBe(1);
    expect(msg.lastError).toContain('smtp down');
    expect(msg.availableAt.getTime()).toBeGreaterThan(before);
  });

  it('dead-letters a message that exhausts its attempts, keeping it for replay', async () => {
    await seed({ attempts: 8, availableAt: new Date(Date.now() - 1000) });

    await relayWith([
      counting('broken', async () => {
        throw new Error('still broken');
      }),
    ]).tick();

    const msg = await prisma.outboxMessage.findFirstOrThrow();
    expect(msg.status).toBe('DEAD');
    expect(msg.lastError).toContain('still broken');
    // Kept, not deleted — a dead letter with no payload cannot be replayed.
    expect(msg.payload).toEqual({ total: 4999 });
  });

  /**
   * The headline property, and the analogue of the 50-concurrent-webhook test that
   * commerce will need in task 1.9: however many times the relay runs, the effect
   * happens once.
   */
  it('produces exactly one effect no matter how often the relay ticks', async () => {
    await seed();
    const enroll = counting('enroll');
    const relay = relayWith([enroll]);

    for (let i = 0; i < 10; i += 1) await relay.tick();

    expect(enroll.calls).toBe(1);
    expect(await prisma.processedEvent.count()).toBe(1);
  });

  it('recovers a message stuck in PUBLISHING by a crashed relay', async () => {
    const msg = await seed();
    // Simulates a relay that claimed the row and died before delivering.
    await prisma.outboxMessage.update({
      where: { id: msg.id },
      data: { status: 'PUBLISHING', attempts: 1 },
    });
    const enroll = counting('enroll');

    await relayWith([enroll]).tick();

    expect(enroll.calls).toBe(1);
    expect((await prisma.outboxMessage.findFirstOrThrow()).status).toBe('PUBLISHED');
  });
});
