/**
 * A domain event: something that happened, named in the past tense, owned by the context
 * that caused it.
 *
 * Events live in `@masternova/contracts` rather than inside a module because they are the
 * one thing bounded contexts are allowed to share. `commerce` emits `order.paid`;
 * `enrollment` and `notification` react to it without either side importing the other
 * (CLAUDE.md §4).
 */

/** `<context>.<aggregate>.<past-tense-verb>` — e.g. `commerce.order.paid`. */
export type DomainEventType = string;

export interface DomainEvent<TPayload = unknown> {
  /** Stable identity. Survives relay retries, so consumers dedupe on it. */
  readonly eventId: string;
  readonly type: DomainEventType;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
  readonly occurredAt: Date;
  /** W3C traceparent captured where the event was raised, so a trace crosses the queue. */
  readonly traceparent?: string;
}

/**
 * What a producer supplies. `eventId` and `occurredAt` are assigned by the Unit of Work,
 * so a caller cannot accidentally reuse an id and silently suppress a second event.
 */
export interface NewDomainEvent<TPayload = unknown> {
  readonly type: DomainEventType;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
}

/**
 * A reaction to an event. One event may have many handlers, each failing independently —
 * that independence is the force behind the outbox (Observer, CLAUDE.md §2).
 */
export interface DomainEventHandler<TPayload = unknown> {
  /** Stable, unique. It is the dedupe key in `ProcessedEvent`, so renaming it replays. */
  readonly name: string;
  readonly eventType: DomainEventType;
  handle(event: DomainEvent<TPayload>): Promise<void>;
}

/** Multi-provider token: every handler registers against this, the dispatcher collects them. */
export const DOMAIN_EVENT_HANDLER = Symbol('DOMAIN_EVENT_HANDLER');
