import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma, type OutboxMessage } from '@masternova/db';
import type { DomainEvent } from '@masternova/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEventDispatcher } from './domain-event-dispatcher.service';

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * How long a claim is honoured before another relay may take the message.
 *
 * `FOR UPDATE SKIP LOCKED` only protects rows for the life of the claiming transaction.
 * Once that commits, the row sits in PUBLISHING with no lock — so a second relay polling
 * a moment later would claim it again and every effect would happen twice. Pushing
 * `availableAt` into the future at claim time makes the column double as a visibility
 * deadline: in-flight work is invisible, and a relay that dies mid-delivery releases its
 * message automatically once the deadline passes.
 */
const VISIBILITY_TIMEOUT_MS = 5 * 60_000;

/**
 * The read half of the transactional outbox: claim due messages, dispatch them, mark the
 * outcome.
 *
 * Runs in the worker rather than the API because it is a poll loop with a completely
 * different lifecycle from a request — and because the worker is the deployable that
 * scales on queue depth.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: DomainEventDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.logger.log(`outbox relay polling every ${POLL_INTERVAL_MS}ms`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One poll. Guarded so a slow batch cannot overlap itself — without this, a batch that
   * takes longer than the interval would be picked up again by the next tick and the
   * relay would compound its own backlog.
   */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const claimed = await this.claim(BATCH_SIZE);
      for (const message of claimed) {
        await this.deliver(message);
      }
    } catch (error) {
      this.logger.error('relay tick failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  /**
   * Atomically claims a batch.
   *
   * `FOR UPDATE SKIP LOCKED` is the load-bearing part: it lets N relay replicas poll the
   * same table concurrently, each taking a disjoint set of rows, with no coordination and
   * no double delivery. Without SKIP LOCKED the replicas serialise behind each other and
   * the relay stops scaling; without FOR UPDATE they claim the same rows and every effect
   * happens twice.
   *
   * Raw SQL because Prisma has no way to express row-level locking hints.
   */
  private claim(limit: number): Promise<OutboxMessage[]> {
    const visibleAgainAt = new Date(Date.now() + VISIBILITY_TIMEOUT_MS);
    return this.prisma.$queryRaw<OutboxMessage[]>`
      UPDATE "OutboxMessage" m
         SET status = 'PUBLISHING'::"OutboxStatus",
             attempts = m.attempts + 1,
             "availableAt" = ${visibleAgainAt}
       WHERE m.id IN (
         SELECT c.id
           FROM "OutboxMessage" c
          WHERE c.status IN ('PENDING'::"OutboxStatus", 'PUBLISHING'::"OutboxStatus")
            AND c."availableAt" <= now()
          ORDER BY c."createdAt"
          LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
       )
      RETURNING m.*;
    `;
  }

  private async deliver(message: OutboxMessage): Promise<void> {
    try {
      await this.dispatcher.dispatch(toDomainEvent(message));
      await this.prisma.outboxMessage.update({
        where: { id: message.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), lastError: null },
      });
    } catch (error) {
      await this.recordFailure(message, error);
    }
  }

  /**
   * Exponential backoff, then a dead letter.
   *
   * A message that has exhausted its attempts is parked as DEAD rather than retried
   * forever or deleted: retrying forever lets one poisonous message starve the batch,
   * and deleting destroys the evidence needed to replay it after the bug is fixed.
   */
  private async recordFailure(message: OutboxMessage, error: unknown): Promise<void> {
    const dead = message.attempts >= MAX_ATTEMPTS;
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (message.attempts - 1), MAX_BACKOFF_MS);

    await this.prisma.outboxMessage.update({
      where: { id: message.id },
      data: {
        status: dead ? 'DEAD' : 'PENDING',
        availableAt: dead ? message.availableAt : new Date(Date.now() + backoff),
        lastError: truncate(describe(error), 1000),
      },
    });

    if (dead) {
      this.logger.error(
        `outbox message ${message.id} (${message.type}) is DEAD after ${message.attempts} attempts`,
      );
    }
  }
}

/** Row -> event. The relay is the only place that knows both shapes. */
function toDomainEvent(message: OutboxMessage): DomainEvent {
  return {
    eventId: message.eventId,
    type: message.type,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    payload: message.payload as Prisma.JsonObject,
    occurredAt: message.createdAt,
    traceparent: message.traceparent ?? undefined,
  };
}

/**
 * Flattens an error into something a human can act on from the `lastError` column.
 *
 * An AggregateError's own message only says how many handlers failed; the reason lives in
 * its causes. A dead letter that records "1/1 handler(s) failed" tells whoever is holding
 * the pager nothing at all.
 */
function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors.map((e) => (e instanceof Error ? e.message : String(e)));
    return `${error.message}: ${causes.join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
