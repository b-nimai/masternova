import { signUnsubscribeToken } from '@masternova/contracts';
import type { NotificationCategory, NotificationPreference } from '@masternova/db';
import { NotificationPreferencesService } from './notification-preferences.service';
import type { INotificationPreferenceRepository } from './repositories/notification.repository.interface';
import { InvalidUnsubscribeTokenException } from '../../common/exceptions';

const SECRET = 'unsubscribe-secret-long-enough-for-hmac';

class FakePreferences implements INotificationPreferenceRepository {
  rows = new Map<string, boolean>();

  listFor(userId: string): Promise<NotificationPreference[]> {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${userId}:`))
        .map(([key, enabled]) => ({
          userId,
          category: key.split(':')[1] as NotificationCategory,
          enabled,
          updatedAt: new Date(),
        })),
    );
  }

  set(userId: string, category: NotificationCategory, enabled: boolean): Promise<void> {
    this.rows.set(`${userId}:${category}`, enabled);
    return Promise.resolve();
  }
}

const build = () => {
  const preferences = new FakePreferences();
  const service = new NotificationPreferencesService(preferences, {
    unsubscribeSecret: SECRET,
    webhookSecret: undefined,
  });
  return { service, preferences };
};

describe('NotificationPreferencesService', () => {
  it('returns every optional category for a user who has never chosen anything', async () => {
    const { service } = build();

    const { preferences } = await service.listFor('user-1');

    // Absent row means subscribed. Returning only stored rows would render as "no
    // preferences" on a fresh account and push the default into the UI.
    expect(preferences).toHaveLength(3);
    expect(preferences.every((p) => p.enabled)).toBe(true);
  });

  it('never offers a mandatory category, rather than offering it disabled', async () => {
    const { service } = build();

    const { preferences } = await service.listFor('user-1');

    expect(preferences.map((p) => p.category)).not.toContain('ACCOUNT_SECURITY');
    expect(preferences.map((p) => p.category)).not.toContain('PURCHASE');
  });

  it('reflects a stored opt-out', async () => {
    const { service, preferences } = build();
    await service.set('user-1', 'ENGAGEMENT', false);

    const result = await service.listFor('user-1');

    expect(result.preferences.find((p) => p.category === 'ENGAGEMENT')?.enabled).toBe(false);
    expect(preferences.rows.get('user-1:ENGAGEMENT')).toBe(false);
  });

  describe('unsubscribe', () => {
    it('turns off exactly the category the token names, and nothing else', async () => {
      const { service, preferences } = build();
      const token = signUnsubscribeToken(SECRET, { userId: 'user-1', category: 'PRODUCT_NEWS' });

      await service.unsubscribe(token);

      expect(preferences.rows.get('user-1:PRODUCT_NEWS')).toBe(false);
      expect(preferences.rows.has('user-1:ENGAGEMENT')).toBe(false);
    });

    it('is idempotent — a prefetching mail client clicking twice changes nothing extra', async () => {
      const { service, preferences } = build();
      const token = signUnsubscribeToken(SECRET, { userId: 'user-1', category: 'ENGAGEMENT' });

      await service.unsubscribe(token);
      await service.unsubscribe(token);

      expect(preferences.rows.get('user-1:ENGAGEMENT')).toBe(false);
    });

    it('rejects a token signed with a different secret', async () => {
      const { service } = build();
      const forged = signUnsubscribeToken('some-other-secret-entirely-long-enough', {
        userId: 'user-1',
        category: 'PRODUCT_NEWS',
      });

      await expect(service.unsubscribe(forged)).rejects.toBeInstanceOf(
        InvalidUnsubscribeTokenException,
      );
    });

    it('rejects a tampered payload', async () => {
      const { service } = build();
      const token = signUnsubscribeToken(SECRET, { userId: 'user-1', category: 'PRODUCT_NEWS' });
      const [version, , signature] = token.split('.');
      const swapped = Buffer.from('user-2:PRODUCT_NEWS', 'utf8').toString('base64url');

      await expect(
        service.unsubscribe(`${version}.${swapped}.${signature}`),
      ).rejects.toBeInstanceOf(InvalidUnsubscribeTokenException);
    });

    it('rejects garbage instead of throwing something the filter cannot shape', async () => {
      const { service } = build();
      for (const bad of ['', 'nonsense', 'v1.only-two', 'v9.abc.def']) {
        await expect(service.unsubscribe(bad)).rejects.toBeInstanceOf(
          InvalidUnsubscribeTokenException,
        );
      }
    });

    /** The worker never mints one, so a valid signature over a mandatory category means
     *  the secret leaked or the category list moved. Either way, refuse. */
    it('refuses a validly-signed token for a mandatory category', async () => {
      const { service, preferences } = build();
      const token = signUnsubscribeToken(SECRET, {
        userId: 'user-1',
        category: 'ACCOUNT_SECURITY',
      });

      await expect(service.unsubscribe(token)).rejects.toBeInstanceOf(
        InvalidUnsubscribeTokenException,
      );
      expect(preferences.rows.size).toBe(0);
    });
  });
});
