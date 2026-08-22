import {
  IdentityEvent,
  type DomainEvent,
  type DomainEventHandler,
  type EmailVerifiedPayload,
  type PasswordChangedPayload,
  type RefreshReuseDetectedPayload,
  type UserRegisteredPayload,
  type VerificationRequestedPayload,
} from '@masternova/contracts';
import { EventHandler } from '../../../common/decorators/event-handler.decorator';
import { TemplateKey } from '../templates/template-keys';
import { NotificationService } from '../notification.service';

/**
 * The Observer half of the module: one small class per (event → email) pair.
 *
 * They are separate classes rather than one table-driven handler because
 * `DomainEventHandler.name` is the dedupe key in `ProcessedEvent`. A class per pair means
 * each mapping is independently registered, independently retried, and independently
 * skippable — adding "receipt on order paid" later must not replay "verify your email"
 * for every historic signup, and it will not, because the names differ.
 *
 * Every handler is idempotent twice over: the kernel skips a handler that already ran for
 * an event, and `EmailDelivery`'s unique key makes a send that slips past that a no-op.
 */

/** Shared plumbing — not a base class; a two-line helper is not worth an inheritance chain. */
function send(
  notifications: NotificationService,
  event: DomainEvent<{ email?: string | null }>,
  templateKey: string,
): Promise<void> {
  const email = event.payload.email;
  if (!email) {
    // An event that reached a mail handler without an address is a producer bug, but
    // throwing would park the outbox message as DEAD and take the retry budget with it.
    // Nothing to send is not a failure to send.
    return Promise.resolve();
  }
  return notifications.send({
    eventId: event.eventId,
    templateKey,
    to: email,
    userId: event.aggregateId,
    payload: event.payload,
  });
}

@EventHandler()
export class SendVerificationEmail implements DomainEventHandler<VerificationRequestedPayload> {
  readonly name = 'notification:verify-email';
  readonly eventType = IdentityEvent.EmailVerificationRequested;

  constructor(private readonly notifications: NotificationService) {}

  handle(event: DomainEvent<VerificationRequestedPayload>): Promise<void> {
    return send(this.notifications, event, TemplateKey.VerifyEmail);
  }
}

@EventHandler()
export class SendWelcomeOnVerified implements DomainEventHandler<EmailVerifiedPayload> {
  readonly name = 'notification:welcome-on-verified';
  readonly eventType = IdentityEvent.EmailVerified;

  constructor(private readonly notifications: NotificationService) {}

  handle(event: DomainEvent<EmailVerifiedPayload>): Promise<void> {
    return send(this.notifications, event, TemplateKey.Welcome);
  }
}

/**
 * OAuth signups never produce `EmailVerified` — the provider already proved the address,
 * so no verification token is issued and nothing is redeemed. Without this handler they
 * would be the one cohort that never gets a welcome.
 */
@EventHandler()
export class SendWelcomeOnOAuthSignup implements DomainEventHandler<UserRegisteredPayload> {
  readonly name = 'notification:welcome-on-oauth-signup';
  readonly eventType = IdentityEvent.UserRegistered;

  constructor(private readonly notifications: NotificationService) {}

  handle(event: DomainEvent<UserRegisteredPayload>): Promise<void> {
    if (!event.payload.verified) return Promise.resolve();
    return send(this.notifications, event, TemplateKey.Welcome);
  }
}

@EventHandler()
export class SendPasswordResetEmail implements DomainEventHandler<VerificationRequestedPayload> {
  readonly name = 'notification:password-reset';
  readonly eventType = IdentityEvent.PasswordResetRequested;

  constructor(private readonly notifications: NotificationService) {}

  handle(event: DomainEvent<VerificationRequestedPayload>): Promise<void> {
    return send(this.notifications, event, TemplateKey.PasswordReset);
  }
}

@EventHandler()
export class SendPasswordChangedNotice implements DomainEventHandler<PasswordChangedPayload> {
  readonly name = 'notification:password-changed';
  readonly eventType = IdentityEvent.PasswordChanged;

  constructor(private readonly notifications: NotificationService) {}

  handle(event: DomainEvent<PasswordChangedPayload>): Promise<void> {
    return send(this.notifications, event, TemplateKey.PasswordChanged);
  }
}

/** The half of reuse detection that gives the account owner something to act on. */
@EventHandler()
export class SendSecurityAlert implements DomainEventHandler<RefreshReuseDetectedPayload> {
  readonly name = 'notification:security-alert';
  readonly eventType = IdentityEvent.RefreshReuseDetected;

  constructor(private readonly notifications: NotificationService) {}

  handle(event: DomainEvent<RefreshReuseDetectedPayload>): Promise<void> {
    return send(this.notifications, event, TemplateKey.SecurityAlert);
  }
}

export const IDENTITY_NOTIFICATION_HANDLERS = [
  SendVerificationEmail,
  SendWelcomeOnVerified,
  SendWelcomeOnOAuthSignup,
  SendPasswordResetEmail,
  SendPasswordChangedNotice,
  SendSecurityAlert,
];
