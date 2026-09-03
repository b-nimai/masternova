import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient } from '@masternova/db';
import { PrismaUnitOfWork } from '@masternova/db/unit-of-work';
import type { PrismaService } from '../src/prisma/prisma.service';
import { startDatabase } from './setup-db';

/**
 * The claim this module makes is atomicity, and atomicity cannot be tested with a fake —
 * a fake would simply do what it was told. These run against a real Postgres.
 */
describe('PrismaUnitOfWork (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let uow: PrismaUnitOfWork;

  beforeAll(async () => {
    ({ container, prisma } = await startDatabase());
    uow = new PrismaUnitOfWork(prisma as unknown as PrismaService);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.outboxMessage.deleteMany();
    await prisma.user.deleteMany();
  });

  it('commits the state change and its events together', async () => {
    await uow.execute(async (ctx) => {
      const tx = ctx.executor as PrismaClient;
      const user = await tx.user.create({
        data: { email: 'commit@masternova.in', name: 'Commit' },
      });
      ctx.publish({
        type: 'identity.user.registered',
        aggregateType: 'User',
        aggregateId: user.id,
        payload: { email: user.email },
      });
    });

    expect(await prisma.user.count()).toBe(1);
    const messages = await prisma.outboxMessage.findMany();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'identity.user.registered',
      aggregateType: 'User',
      status: 'PENDING',
      attempts: 0,
    });
  });

  /**
   * The failure this pattern exists to prevent: state committed, event lost. If the outbox
   * write were outside the transaction, this test would leave a user with no event — or,
   * worse in the reverse case, an event for a user who does not exist.
   */
  it('discards the events when the transaction rolls back', async () => {
    await expect(
      uow.execute(async (ctx) => {
        const tx = ctx.executor as PrismaClient;
        await tx.user.create({ data: { email: 'rollback@masternova.in' } });
        ctx.publish({
          type: 'identity.user.registered',
          aggregateType: 'User',
          aggregateId: 'whatever',
          payload: {},
        });
        throw new Error('business rule violated after publishing');
      }),
    ).rejects.toThrow('business rule violated');

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.outboxMessage.count()).toBe(0);
  });

  it('assigns a distinct eventId per event, so nothing is silently swallowed', async () => {
    await uow.execute(async (ctx) => {
      for (let i = 0; i < 25; i += 1) {
        ctx.publish({
          type: 'catalog.course.published',
          aggregateType: 'Course',
          aggregateId: `course-${i}`,
          payload: { i },
        });
      }
    });

    const ids = (await prisma.outboxMessage.findMany({ select: { eventId: true } })).map(
      (m) => m.eventId,
    );
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
  });

  it('writes nothing when the work raises no events', async () => {
    await uow.execute(async (ctx) => {
      const tx = ctx.executor as PrismaClient;
      await tx.user.create({ data: { email: 'quiet@masternova.in' } });
    });

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.outboxMessage.count()).toBe(0);
  });
});
