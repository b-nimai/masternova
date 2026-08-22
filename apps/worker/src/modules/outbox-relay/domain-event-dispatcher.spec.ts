import { DomainEventDispatcher } from './domain-event-dispatcher.service';
import type { DomainEvent, DomainEventHandler } from '@masternova/contracts';

/**
 * Pure unit tests — no database (CLAUDE.md §6). Prisma is replaced by a fake that records
 * what was written, because the behaviour under test is the fan-out and dedupe logic, not
 * the persistence.
 */

class FakePrisma {
  processed = new Set<string>();
  processedEvent = {
    findUnique: async ({
      where,
    }: {
      where: { eventId_handler: { eventId: string; handler: string } };
    }) => {
      const k = `${where.eventId_handler.eventId}:${where.eventId_handler.handler}`;
      return this.processed.has(k) ? { eventId: '', handler: '', processedAt: new Date() } : null;
    },
    createMany: async ({ data }: { data: { eventId: string; handler: string }[] }) => {
      for (const row of data) this.processed.add(`${row.eventId}:${row.handler}`);
      return { count: data.length };
    },
  };
}

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  eventId: 'evt-1',
  type: 'commerce.order.paid',
  aggregateType: 'Order',
  aggregateId: 'ord-1',
  payload: { total: 4999 },
  occurredAt: new Date(),
  ...over,
});

const handler = (
  name: string,
  eventType = 'commerce.order.paid',
  impl?: () => Promise<void>,
): DomainEventHandler & { calls: number } => {
  const h = {
    name,
    eventType,
    calls: 0,
    async handle() {
      h.calls += 1;
      if (impl) await impl();
    },
  };
  return h;
};

const make = (handlers: DomainEventHandler[], prisma = new FakePrisma()) => {
  const dispatcher = new DomainEventDispatcher(prisma as any);
  dispatcher.register(...handlers);
  return [dispatcher, prisma] as const;
};

describe('DomainEventDispatcher', () => {
  it('runs every handler registered for the event type', async () => {
    const a = handler('enroll');
    const b = handler('send-receipt');
    const [dispatcher] = make([a, b]);

    await dispatcher.dispatch(event());

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });

  it('does not run handlers registered for a different type', async () => {
    const other = handler('index-course', 'catalog.course.published');
    const [dispatcher] = make([other]);

    await dispatcher.dispatch(event());

    expect(other.calls).toBe(0);
  });

  it('treats an event with no handlers as success, not an error', async () => {
    const [dispatcher] = make([]);
    await expect(dispatcher.dispatch(event())).resolves.toBeUndefined();
  });

  /** The property the whole outbox exists to provide. */
  it('runs a handler exactly once across repeated delivery of the same event', async () => {
    const enroll = handler('enroll');
    const [dispatcher] = make([enroll]);

    await dispatcher.dispatch(event());
    await dispatcher.dispatch(event());
    await dispatcher.dispatch(event());

    expect(enroll.calls).toBe(1);
  });

  it('dedupes per handler, so a newly added handler still sees an old event', async () => {
    const enroll = handler('enroll');
    const prisma = new FakePrisma();
    const [first] = make([enroll], prisma);
    await first.dispatch(event());

    const invoice = handler('raise-invoice');
    const [second] = make([enroll, invoice], prisma);
    await second.dispatch(event());

    expect(enroll.calls).toBe(1);
    expect(invoice.calls).toBe(1);
  });

  it('isolates failures — one handler throwing does not stop the others', async () => {
    const failing = handler('broken', 'commerce.order.paid', async () => {
      throw new Error('smtp down');
    });
    const healthy = handler('enroll');
    const [dispatcher] = make([failing, healthy]);

    await expect(dispatcher.dispatch(event())).rejects.toThrow(/1\/2 handler\(s\) failed/);
    expect(healthy.calls).toBe(1);
  });

  it('retries only the handler that failed, never the one that succeeded', async () => {
    let smtpDown = true;
    const email = handler('send-receipt', 'commerce.order.paid', async () => {
      if (smtpDown) throw new Error('smtp down');
    });
    const enroll = handler('enroll');
    const [dispatcher] = make([enroll, email]);

    await expect(dispatcher.dispatch(event())).rejects.toThrow();
    expect(enroll.calls).toBe(1);
    expect(email.calls).toBe(1);

    smtpDown = false;
    await dispatcher.dispatch(event());

    expect(enroll.calls).toBe(1); // already recorded — not re-run
    expect(email.calls).toBe(2); // failed before, so retried
  });

  it('does not mark a handler processed when it throws', async () => {
    const failing = handler('broken', 'commerce.order.paid', async () => {
      throw new Error('nope');
    });
    const [dispatcher, prisma] = make([failing]);

    await expect(dispatcher.dispatch(event())).rejects.toThrow();
    expect(prisma.processed.size).toBe(0);
  });
});
