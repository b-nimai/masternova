import { Inject, Logger } from '@nestjs/common';
import {
  CommerceEvent,
  type DomainEvent,
  type DomainEventHandler,
  type OrderExpiredPayload,
  type OrderPaidPayload,
  type OrderRefundedPayload,
} from '@masternova/contracts';
import { EventHandler } from '../../../common/decorators/event-handler.decorator';
import {
  AUDIENCE_REPOSITORY,
  type IAudienceRepository,
} from '../repositories/audience.repository.interface';
import { TemplateKey } from '../templates/template-keys';
import { NotificationService } from '../notification.service';

/**
 * Commerce's Observer half: the effects of a completed order that can fail on their own.
 *
 * **What is deliberately not here: granting the entitlement.** That happens in the same
 * transaction as the order reaching PAID, because a learner who paid and cannot watch is
 * not an effect that may retry later — see ADR-0020. These two can: a receipt that fails to
 * render is worth retrying, and nothing about the purchase is wrong while it does.
 *
 * The address is resolved here rather than carried in the payload. The alternative is
 * commerce reading `User.email` to raise `order.paid`, which puts notification's concern
 * inside a module that has no business knowing how learners are contacted.
 */
@EventHandler()
export class SendOrderReceiptHandler implements DomainEventHandler<OrderPaidPayload> {
  /** The dedupe key in `ProcessedEvent`, so it must stay stable once it has shipped. */
  readonly name = 'notification:order-receipt';
  readonly eventType = CommerceEvent.OrderPaid;
  private readonly logger = new Logger(SendOrderReceiptHandler.name);

  constructor(
    private readonly notifications: NotificationService,
    @Inject(AUDIENCE_REPOSITORY) private readonly audience: IAudienceRepository,
  ) {}

  async handle(event: DomainEvent<OrderPaidPayload>): Promise<void> {
    const email = await this.audience.emailFor(event.payload.userId);
    if (!email) {
      // A deleted user, or a producer bug. Throwing would burn the outbox retry budget and
      // eventually park the message as DEAD — and there is nothing to send either way.
      this.logger.warn(`no address for user ${event.payload.userId}; skipping receipt`);
      return;
    }

    await this.notifications.send({
      eventId: event.eventId,
      templateKey: TemplateKey.OrderReceipt,
      to: email,
      userId: event.payload.userId,
      payload: event.payload,
    });
  }
}

@EventHandler()
export class SendRefundConfirmationHandler implements DomainEventHandler<OrderRefundedPayload> {
  readonly name = 'notification:order-refunded';
  readonly eventType = CommerceEvent.OrderRefunded;
  private readonly logger = new Logger(SendRefundConfirmationHandler.name);

  constructor(
    private readonly notifications: NotificationService,
    @Inject(AUDIENCE_REPOSITORY) private readonly audience: IAudienceRepository,
  ) {}

  async handle(event: DomainEvent<OrderRefundedPayload>): Promise<void> {
    const email = await this.audience.emailFor(event.payload.userId);
    if (!email) {
      this.logger.warn(`no address for user ${event.payload.userId}; skipping refund notice`);
      return;
    }

    await this.notifications.send({
      eventId: event.eventId,
      templateKey: TemplateKey.OrderRefunded,
      to: email,
      userId: event.payload.userId,
      payload: event.payload,
    });
  }
}

/**
 * The abandoned-checkout nudge.
 *
 * It is here rather than in commerce for the same reason the other two are: commerce's job
 * ended when it released the coupon and marked the order EXPIRED. Whether that fact is worth
 * an email — and whether *this* learner wants one — is notification's question, and the
 * answer is enforced one layer down, because `OrderExpiredTemplate` is an optional category
 * and `NotificationService` drops it for anyone who opted out.
 */
@EventHandler()
export class SendCheckoutRecoveryHandler implements DomainEventHandler<OrderExpiredPayload> {
  readonly name = 'notification:order-expired';
  readonly eventType = CommerceEvent.OrderExpired;
  private readonly logger = new Logger(SendCheckoutRecoveryHandler.name);

  constructor(
    private readonly notifications: NotificationService,
    @Inject(AUDIENCE_REPOSITORY) private readonly audience: IAudienceRepository,
  ) {}

  async handle(event: DomainEvent<OrderExpiredPayload>): Promise<void> {
    // An order can expire with nothing on it if every line was removed before the sweep.
    // There is no course to advertise, so there is no email — and sending "you left
    // behind: (nothing)" is worse than staying quiet.
    if (event.payload.items.length === 0) return;

    const email = await this.audience.emailFor(event.payload.userId);
    if (!email) {
      this.logger.warn(`no address for user ${event.payload.userId}; skipping recovery email`);
      return;
    }

    await this.notifications.send({
      eventId: event.eventId,
      templateKey: TemplateKey.OrderExpired,
      to: email,
      userId: event.payload.userId,
      payload: event.payload,
    });
  }
}
