import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { NewDomainEvent, TransactionContext, UnitOfWork } from '@masternova/contracts';
import { PrismaService } from '../../prisma/prisma.service';

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
 */
@Injectable()
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

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
