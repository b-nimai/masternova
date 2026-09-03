import { CachedEntitlementRepository, entitlementCacheKey } from './cached-entitlement.repository';
import type {
  EntitlementSnapshot,
  IEntitlementRepository,
} from './entitlement.repository.interface';

/** A fake Redis, not a mock: the assertions are about what ends up in the store. */
class FakeRedis {
  readonly store = new Map<string, string>();
  failing = false;

  get = jest.fn(async (key: string) => {
    if (this.failing) throw new Error('redis is down');
    return this.store.get(key) ?? null;
  });

  set = jest.fn(async (key: string, value: string) => {
    if (this.failing) throw new Error('redis is down');
    this.store.set(key, value);
    return 'OK';
  });

  del = jest.fn(async (...keys: string[]) => {
    if (this.failing) throw new Error('redis is down');
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  });
}

const ACTIVE: EntitlementSnapshot = { status: 'ACTIVE', expiresAt: null };
const KEY = entitlementCacheKey('user-1', 'course-1');

describe('CachedEntitlementRepository', () => {
  let redis: FakeRedis;
  let inner: jest.Mocked<IEntitlementRepository>;
  let repo: CachedEntitlementRepository;

  beforeEach(() => {
    redis = new FakeRedis();
    inner = {
      find: jest.fn().mockResolvedValue(ACTIVE),
      grant: jest.fn().mockResolvedValue(undefined),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeByOrder: jest.fn().mockResolvedValue([]),
      forget: jest.fn().mockResolvedValue(undefined),
    };
    repo = new CachedEntitlementRepository(inner, redis as never);
  });

  it('reads through once and serves the rest from the cache', async () => {
    await repo.find('user-1', 'course-1');
    await repo.find('user-1', 'course-1');

    expect(inner.find).toHaveBeenCalledTimes(1);
    expect(redis.store.get(KEY)).toBeDefined();
  });

  /**
   * A stranger hitting a paid course is the traffic shape the cache most needs to absorb —
   * and it is the one a naive cache misses on every single request.
   */
  it('caches the absence of an entitlement too', async () => {
    inner.find.mockResolvedValue(null);

    expect(await repo.find('user-1', 'course-1')).toBeNull();
    expect(await repo.find('user-1', 'course-1')).toBeNull();

    expect(inner.find).toHaveBeenCalledTimes(1);
  });

  /**
   * JSON has no Date. Without reviving it, `expiresAt` returns as a string and every
   * comparison in `ActiveEntitlementPolicy` is `string <= Date` — silently false, which
   * grants access that has already expired.
   */
  it('returns expiresAt as a Date on the cached path, not a string', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    inner.find.mockResolvedValue({ status: 'ACTIVE', expiresAt });

    await repo.find('user-1', 'course-1');
    const cached = await repo.find('user-1', 'course-1');

    expect(cached?.expiresAt).toBeInstanceOf(Date);
    expect(cached?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  describe('invalidation', () => {
    it('drops the key when access is granted', async () => {
      await repo.find('user-1', 'course-1');
      await repo.grant({ userId: 'user-1', courseId: 'course-1', source: 'PURCHASE' });

      expect(redis.store.has(KEY)).toBe(false);
    });

    /** The one that matters: a refund must not keep serving from a stale cache. */
    it('drops the key when access is revoked', async () => {
      await repo.find('user-1', 'course-1');
      await repo.revoke('user-1', 'course-1', 'refund');

      expect(redis.store.has(KEY)).toBe(false);
      expect(inner.revoke).toHaveBeenCalled();
    });

    it('drops every key an order paid for', async () => {
      inner.revokeByOrder.mockResolvedValue([
        { userId: 'user-1', courseId: 'course-1' },
        { userId: 'user-1', courseId: 'course-2' },
      ]);
      await repo.find('user-1', 'course-1');
      await repo.find('user-1', 'course-2');

      await repo.revokeByOrder('order-1', 'refund');

      expect(redis.store.size).toBe(0);
    });

    it('does not call DEL with no keys when an order revoked nothing', async () => {
      await repo.revokeByOrder('order-1', 'refund');
      expect(redis.del).not.toHaveBeenCalled();
    });

    /**
     * Found by review. With an `executor` the caller's transaction has **not committed**, so
     * a DEL here is followed by a concurrent read that finds the pre-write row still in
     * Postgres and re-caches it for the full TTL — a refund that appears not to have
     * happened for five minutes, which is exactly what this Decorator exists to prevent.
     */
    it('does not invalidate while the caller is still inside a transaction', async () => {
      const tx = Symbol('tx');
      await repo.find('user-1', 'course-1');

      await repo.revoke('user-1', 'course-1', 'refund', tx);

      expect(inner.revoke).toHaveBeenCalledWith('user-1', 'course-1', 'refund', tx);
      expect(redis.del).not.toHaveBeenCalled();
      expect(redis.store.has(KEY)).toBe(true);
    });

    it('forgets on demand, which is what the transaction owner calls after it commits', async () => {
      await repo.find('user-1', 'course-1');
      await repo.forget([{ userId: 'user-1', courseId: 'course-1' }]);

      expect(redis.store.has(KEY)).toBe(false);
    });

    it('leaves the cache alone for a transactional grant too', async () => {
      await repo.find('user-1', 'course-1');
      await repo.grant(
        { userId: 'user-1', courseId: 'course-1', source: 'PURCHASE' },
        Symbol('tx'),
      );

      expect(redis.store.has(KEY)).toBe(true);
    });

    /** Deleting, never write-through: two concurrent writers cannot race to install a value. */
    it('deletes rather than writing the new value back', async () => {
      await repo.grant({ userId: 'user-1', courseId: 'course-1', source: 'PURCHASE' });

      expect(redis.del).toHaveBeenCalledWith(KEY);
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('when Redis is down', () => {
    /** A cache that can fail the request it was added to speed up is a liability. */
    it('still answers, from the database', async () => {
      redis.failing = true;
      expect(await repo.find('user-1', 'course-1')).toEqual(ACTIVE);
    });

    /**
     * The refund has already committed. Turning it into a 500 would have the payment
     * webhook retry an operation that succeeded.
     */
    it('does not fail a revoke because the cache could not be cleared', async () => {
      redis.failing = true;
      await expect(repo.revoke('user-1', 'course-1', 'refund')).resolves.toBeUndefined();
      expect(inner.revoke).toHaveBeenCalled();
    });
  });
});
