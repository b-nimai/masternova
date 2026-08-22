import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';

export const EVENT_HANDLER_METADATA = 'masternova:domain-event-handler';

/**
 * Marks a provider as a {@link DomainEventHandler} so the dispatcher can find it.
 *
 * The force is CLAUDE.md §1 O — **extend by adding, not editing**. Without this, every
 * new consumer has to be threaded into the kernel: a token imported, a provider array
 * appended, a module imported by `outbox-relay`. That means adding a receipt email edits
 * the outbox, and it also means the kernel imports a bounded context, which §4 forbids
 * outright.
 *
 * With it, a handler is discovered wherever it lives. The dispatcher never learns which
 * contexts exist, and `notification` never learns the kernel's file layout.
 */
export const EventHandler = (): ClassDecorator =>
  applyDecorators(Injectable(), SetMetadata(EVENT_HANDLER_METADATA, true));
