import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { verifyUnsubscribeToken } from '@masternova/contracts';
import { OPTIONAL_NOTIFICATION_CATEGORIES, type NotificationPreferences } from '@masternova/shared';
import type { NotificationCategory } from '@masternova/db';
import { notificationConfig } from '../../config/configuration';
import { InvalidUnsubscribeTokenException } from '../../common/exceptions';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  type INotificationPreferenceRepository,
} from './repositories/notification.repository.interface';

/**
 * The preference centre: what a user has chosen, and the two ways they change it — the
 * settings screen, and the unsubscribe link at the bottom of an email.
 *
 * It owns consent and nothing else. It does not send, does not render, and does not know
 * a provider exists; those live in the worker.
 */
@Injectable()
export class NotificationPreferencesService {
  private readonly logger = new Logger(NotificationPreferencesService.name);

  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: INotificationPreferenceRepository,
    @Inject(notificationConfig.KEY)
    private readonly config: ConfigType<typeof notificationConfig>,
  ) {}

  /**
   * Always the complete list of optional categories, never a sparse map of stored rows.
   *
   * An absent row means subscribed, so returning only what is stored would render as "no
   * preferences" on a fresh account and the UI would have to reimplement the default. The
   * default belongs in one place, and this is it.
   *
   * Mandatory categories are not in the response at all. A disabled checkbox invites the
   * question "why can't I turn this off?"; not offering it is the honest answer.
   */
  async listFor(userId: string): Promise<NotificationPreferences> {
    const stored = new Map(
      (await this.preferences.listFor(userId)).map((row) => [row.category as string, row.enabled]),
    );

    return {
      preferences: OPTIONAL_NOTIFICATION_CATEGORIES.map((category) => ({
        category,
        enabled: stored.get(category) ?? true,
        editable: true as const,
      })),
    };
  }

  async set(userId: string, category: NotificationCategory, enabled: boolean): Promise<void> {
    await this.preferences.set(userId, category, enabled);
  }

  /**
   * Unsubscribe from an emailed link.
   *
   * Deliberately unauthenticated: someone who has stopped wanting our email is exactly the
   * person who will not log in to say so, and forcing a sign-in is how an unsubscribe
   * becomes a spam complaint instead. The HMAC in the token is what stands in for the
   * session, and it is scoped to one user and one category so it cannot do anything else.
   */
  async unsubscribe(token: string): Promise<{ category: string }> {
    const claims = verifyUnsubscribeToken(this.config.unsubscribeSecret, token);
    if (!claims) throw new InvalidUnsubscribeTokenException();

    if (!isOptional(claims.category)) {
      // A signed token for a mandatory category cannot exist — the worker never mints one.
      // Reaching here means the secret leaked or the category list changed under us.
      this.logger.warn(`unsubscribe token for non-optional category ${claims.category}`);
      throw new InvalidUnsubscribeTokenException();
    }

    await this.preferences.set(claims.userId, claims.category as NotificationCategory, false);
    return { category: claims.category };
  }
}

function isOptional(category: string): boolean {
  return (OPTIONAL_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
}
