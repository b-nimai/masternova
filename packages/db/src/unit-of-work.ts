import { randomUUID } from 'node:crypto';
import type { NewDomainEvent, TransactionContext, UnitOfWork } from '@masternova/contracts';
import type { PrismaClient } from '@prisma/client';

/**
 * Prisma-backed {@link UnitOfWork}.
 *
 * Events raised during the work are buffered in memory and written to the outbox as the
 * last statement of the SAME transaction. Two consequences worth stating out loud:
 *
 *  - A rollback discards the events with the state change. There is no window in which an
 *    event describes something that did not happen.
 *  - A crash after commit loses nothing. The rows are already durable, and the relay picks
 *    them up on its next poll.
 *
 * This is the half of the outbox pattern that people skip, and skipping it is why
 * "we publish after saving" systems lose effects under load.
 *
 * **It lives in a package because both deployables publish.** The API raises events on the
 * request path (tasks 1.2–1.6) and the worker raises them at the end of the transcode
 * pipeline (task 1.7). Keeping the implementation in `apps/api` would have left the worker
 * to write `outboxMessage.createMany` by hand — a second copy of the one mechanism the
 * whole outbox argument depends on, free to drift from the original. Same resolution as
 * `packages/storage`.
 *
 * It takes a `PrismaClient` rather than a Nest `PrismaService`, so the package stays free
 * of both apps' DI wiring; each app binds it to `UNIT_OF_WORK` with its own client.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  async execute<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const buffered: NewDomainEvent[] = [];

      const ctx: TransactionContext = {
        executor: tx,
        publish: (event) => {
          buffered.push(event);
        },
      };

      const result = await work(ctx);

      if (buffered.length > 0) {
        await tx.outboxMessage.createMany({
          data: buffered.map((event) => ({
            // Assigned here, not by the caller: a reused id would be silently swallowed
            // by the unique constraint, turning a real second event into a no-op.
            eventId: randomUUID(),
            type: event.type,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            payload: event.payload as object,
            traceparent: currentTraceparent(),
          })),
        });
      }

      return result;
    });
  }
}

/**
 * Placeholder until OpenTelemetry lands in task 2.10. Returning undefined is honest —
 * the column is nullable, and a fabricated traceparent would be worse than none.
 */
function currentTraceparent(): string | undefined {
  return undefined;
}
