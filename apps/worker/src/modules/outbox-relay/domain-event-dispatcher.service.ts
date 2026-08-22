import { Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { type DomainEvent, type DomainEventHandler } from '@masternova/contracts';
import { EVENT_HANDLER_METADATA } from '../../common/decorators/event-handler.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Fans one event out to every handler registered for its type (Observer).
 *
 * The force: one cause, many effects that fail independently. An order being paid must
 * enroll the learner, raise an invoice, and send a receipt. A bounced email must not
 * un-enroll anyone, and a failing search indexer must not block the receipt. So each
 * handler is isolated, deduped and retried on its own.
 *
 * Delivery is at-least-once — the relay can crash between a handler succeeding and the
 * message being marked published. `ProcessedEvent` is what converts that into
 * exactly-once *effects*: a handler that has already run for an event is skipped.
 *
 * Handlers are **discovered**, not injected. Anything decorated `@EventHandler()`
 * anywhere in the application is picked up at bootstrap, which is what lets a bounded
 * context add a consumer without editing this file or being imported by it (CLAUDE.md
 * §1 O and §4). Discovery runs at `onApplicationBootstrap` rather than in the
 * constructor because that is the first point at which every provider has an instance.
 */
@Injectable()
export class DomainEventDispatcher implements OnApplicationBootstrap {
  private readonly logger = new Logger(DomainEventDispatcher.name);
  private readonly byType = new Map<string, DomainEventHandler[]>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly discovery?: DiscoveryService,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.discovery || !this.reflector) return;

    const discovered = this.discovery
      .getProviders()
      .filter((wrapper) => wrapper.metatype && wrapper.instance)
      .filter((wrapper) => this.reflector?.get(EVENT_HANDLER_METADATA, wrapper.metatype!))
      .map((wrapper) => wrapper.instance as DomainEventHandler);

    this.register(...discovered);
    this.logger.log(`registered ${discovered.length} domain event handler(s)`);
  }

  /**
   * Adds handlers to the routing table. Public so a test can build a dispatcher with
   * exactly the handlers it wants to reason about, with no DI container involved.
   */
  register(...handlers: DomainEventHandler[]): void {
    for (const handler of handlers) {
      const existing = this.byType.get(handler.eventType) ?? [];
      existing.push(handler);
      this.byType.set(handler.eventType, existing);
    }
  }

  /**
   * Runs every handler for the event. Throws if any handler failed, so the relay leaves
   * the message for retry.
   *
   * Handlers run sequentially and independently: one failing does not prevent the others
   * from running, and the ones that succeeded are recorded, so a retry re-runs only what
   * actually failed.
   */
  async dispatch(event: DomainEvent): Promise<void> {
    const handlers = this.byType.get(event.type) ?? [];

    if (handlers.length === 0) {
      // Not an error. An event with no listener today may gain one tomorrow, and the
      // producer is not supposed to know or care who is listening.
      this.logger.debug(`no handler for ${event.type} (${event.eventId})`);
      return;
    }

    const failures: { handler: string; error: unknown }[] = [];

    for (const handler of handlers) {
      try {
        await this.runOnce(handler, event);
      } catch (error) {
        failures.push({ handler: handler.name, error });
        this.logger.error(
          `handler ${handler.name} failed for ${event.type} (${event.eventId})`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => (f.error instanceof Error ? f.error : new Error(String(f.error)))),
        `${failures.length}/${handlers.length} handler(s) failed for ${event.type}`,
      );
    }
  }

  /**
   * Runs a handler unless it has already run for this event.
   *
   * The `ProcessedEvent` row is written AFTER the handler succeeds, not before: marking
   * first would drop the effect entirely if the handler then threw. Writing after means a
   * crash in the gap re-runs the handler — at-least-once — which is why handlers must be
   * idempotent in their own right. That requirement is stated here rather than assumed.
   */
  private async runOnce(handler: DomainEventHandler, event: DomainEvent): Promise<void> {
    const already = await this.prisma.processedEvent.findUnique({
      where: { eventId_handler: { eventId: event.eventId, handler: handler.name } },
    });

    if (already) {
      this.logger.debug(`skipping ${handler.name} for ${event.eventId} — already processed`);
      return;
    }

    await handler.handle(event);

    // A concurrent relay may have written this between the check and here; that is
    // benign, so the duplicate is ignored rather than treated as a failure.
    await this.prisma.processedEvent.createMany({
      data: [{ eventId: event.eventId, handler: handler.name }],
      skipDuplicates: true,
    });
  }
}
