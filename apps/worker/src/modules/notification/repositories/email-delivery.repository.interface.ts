import type { EmailDeliveryStatus, NotificationCategory } from '@masternova/db';

export const EMAIL_DELIVERY_REPOSITORY = Symbol('EMAIL_DELIVERY_REPOSITORY');

export interface DeliveryDescriptor {
  readonly eventId: string;
  readonly template: string;
  readonly recipient: string;
  readonly userId?: string;
  readonly category: NotificationCategory;
  readonly subject: string;
}

export type ClaimOutcome =
  | { readonly claimed: true; readonly id: string }
  /** Someone else already sent this, or is sending it right now. */
  | { readonly claimed: false; readonly reason: string };

/**
 * The delivery log, and the thing that makes sending idempotent.
 *
 * Behind an interface because `NotificationService` is unit-tested with a fake — the
 * pipeline's rules (suppression wins, mandatory categories ignore preferences, a failed
 * send is retryable) are decisions, not queries, and proving them should not need a
 * database (CLAUDE.md §6).
 */
export interface IEmailDeliveryRepository {
  /**
   * Claims the right to send this exact email, or reports that it is already handled.
   *
   * The unique constraint on `(eventId, template, recipient)` is the lock. Reading first
   * and inserting second would leave a window in which two relay replicas both see
   * "nothing sent yet" and both send; letting the database arbitrate closes it, because
   * exactly one INSERT can win.
   */
  claim(descriptor: DeliveryDescriptor): Promise<ClaimOutcome>;
  markSent(id: string, providerMessageId: string): Promise<void>;
  markFailed(id: string, detail: string): Promise<void>;
  /** Records a deliberate non-send, so the delivery log answers "why didn't this arrive?". */
  recordSuppressed(descriptor: DeliveryDescriptor, detail: string): Promise<void>;
  /** Used by the bounce webhook to find the row a provider is telling us about. */
  markByProviderMessageId(
    providerMessageId: string,
    status: EmailDeliveryStatus,
    detail: string,
  ): Promise<number>;
}
