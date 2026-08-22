import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { OutboxRelayService } from './outbox-relay.service';
import { DomainEventDispatcher } from './domain-event-dispatcher.service';

/**
 * The read half of the transactional outbox. Handlers are discovered through
 * `DiscoveryModule` — anything decorated `@EventHandler()` is collected at bootstrap —
 * so the dispatcher never learns which bounded contexts exist, and no context has to be
 * imported here to be heard. That is what keeps `commerce` from importing `notification`
 * in order to send a receipt.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [OutboxRelayService, DomainEventDispatcher],
  exports: [DomainEventDispatcher],
})
export class OutboxRelayModule {}
