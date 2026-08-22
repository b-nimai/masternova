import type { NotificationCategory, SuppressionReason } from '@masternova/db';

export const AUDIENCE_REPOSITORY = Symbol('AUDIENCE_REPOSITORY');

/**
 * Answers one question: may we email this person about this kind of thing?
 *
 * Split from the delivery log because the two change for different reasons (CLAUDE.md
 * §1 S) — this one changes when the consent rules change, that one when the send
 * bookkeeping does. It is also two-method rather than six on purpose (§1 I): the send
 * pipeline needs to *ask*, and only the API's preference centre needs to *write*.
 */
export interface IAudienceRepository {
  /**
   * A hard bounce or a spam complaint on the address itself. Outranks every preference
   * and every mandatory category — continuing to send to a mailbox that does not exist
   * is what gets a sending domain blocklisted.
   */
  suppressionFor(email: string): Promise<{ reason: SuppressionReason } | null>;

  /** Absent row means subscribed, so a new user needs no rows written at signup. */
  hasOptedOut(userId: string, category: NotificationCategory): Promise<boolean>;
}
