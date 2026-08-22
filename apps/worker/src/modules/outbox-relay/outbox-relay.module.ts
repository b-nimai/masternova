import { Module } from '@nestjs/common';
import { OutboxRelayService } from './outbox-relay.service';
import { DomainEventDispatcher } from './domain-event-dispatcher.service';

/**
 * The read half of the transactional outbox. Handlers register themselves against the
 * `DOMAIN_EVENT_HANDLER` multi-token from `@masternova/contracts`; the dispatcher collects
 * them without knowing which contexts exist, which is what keeps `commerce` from having to
 * import `notification` to send a receipt.
 */
@Module({
  providers: [OutboxRelayService, DomainEventDispatcher],
  exports: [DomainEventDispatcher],
})
export class OutboxRelayModule {}
