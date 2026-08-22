import type {
  EmailDeliveryStatus,
  NotificationCategory,
  NotificationPreference,
  SuppressionReason,
} from '@masternova/db';

export const NOTIFICATION_PREFERENCE_REPOSITORY = Symbol('NOTIFICATION_PREFERENCE_REPOSITORY');
export const SUPPRESSION_REPOSITORY = Symbol('SUPPRESSION_REPOSITORY');

/**
 * The write side of consent. Its counterpart in the worker is read-only and two methods
 * wide — deliberately, because the send pipeline must not be able to change a preference
 * (CLAUDE.md §1 I: small, role-shaped interfaces).
 */
export interface INotificationPreferenceRepository {
  listFor(userId: string): Promise<NotificationPreference[]>;
  set(userId: string, category: NotificationCategory, enabled: boolean): Promise<void>;
}

/** Bounces and complaints. Written by the provider webhook, never by a user. */
export interface ISuppressionRepository {
  suppress(email: string, reason: SuppressionReason, detail?: string): Promise<void>;
  markDeliveryByProviderMessageId(
    providerMessageId: string,
    status: EmailDeliveryStatus,
    detail: string,
  ): Promise<{ recipient: string } | null>;
}
