import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import { PrismaService } from '../../prisma/prisma.service';
import { orphansIn, type AssetInventory } from './orphan-scan';
import { assetPrefix } from './output-keys';

/** Hourly. Orphans cost storage, not correctness — there is nothing to chase in seconds. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

/** Assets examined per sweep, so one pass is a predictable amount of provider traffic. */
const SWEEP_BATCH = 100;

/**
 * Deletes pipeline outputs that nothing accounts for.
 *
 * **Why this is needed at all.** Every stage is idempotent by writing to a deterministic
 * key, which makes a retry overwrite rather than duplicate — but it does not clean up after
 * a key that stopped being produced. Change the ABR ladder and every asset keeps its old
 * rungs forever: billed, unreferenced, and invisible unless someone lists the bucket.
 *
 * **Deliberately conservative.** `orphansIn` is pure, separately tested, and keeps anything
 * it cannot classify. A skipped orphan costs storage; a wrong deletion costs a lecture that
 * a learner has paid for, which is not a trade worth being clever about.
 *
 * The upload reaper (task 1.6) makes the mirror-image sweep on the *ingest* side, and is
 * still in the API because it predates this file. Moving it here is the follow-up recorded
 * against 1.6 in `BUILD_PLAN.md` §2.2 — the trigger moves, `sweep()` is what it calls.
 */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  /**
   * Where the next sweep resumes: a **keyset cursor**, not an offset (ADR-0015).
   *
   * Without it every pass re-examined the same oldest 100 assets forever — deleting an
   * object does not touch `Asset.updatedAt`, so the batch never changed and asset 101
   * onwards was never reconciled. It looked healthy, because a sweep that finds nothing
   * reports zero deletions exactly like a sweep that has already cleaned its batch.
   *
   * Ordered by `id` rather than `updatedAt`: the cursor has to be unique and stable, and
   * `updatedAt` is neither. It is in-memory on purpose — a restart resumes from the start of
   * the bucket, which costs one extra pass of an hourly janitor and saves a table.
   */
  private cursor?: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass. Returns how many objects it deleted — what the integration test asserts and
   * what a metric would export.
   *
   * Driven from the **database**, not from a bucket listing. Walking the bucket would be
   * the other way round and is worse at scale: `ListObjectsV2` over a million-object bucket
   * to find a handful of strays, versus one indexed query for the assets that could have
   * them. The cost of that choice is honest and stated — an asset row deleted outright is
   * invisible to this sweep, and the row's own cascade is what has to clean up after it.
   */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const assets = await this.prisma.asset.findMany({
        where: { kind: 'VIDEO', pipeline: { in: ['READY', 'FAILED'] } },
        select: { id: true, pipeline: true, renditions: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
        ...(this.cursor ? { cursor: { id: this.cursor }, skip: 1 } : {}),
      });

      // A short page is the end of the table, so the next sweep starts over. Advancing past
      // the last row instead would leave the cursor permanently beyond every asset and the
      // sweeper would never look at anything again.
      this.cursor = assets.length === SWEEP_BATCH ? assets[assets.length - 1].id : undefined;

      let deleted = 0;

      for (const asset of assets) {
        const inventory: AssetInventory = {
          assetId: asset.id,
          exists: true,
          // FAILED counts as settled: nothing is writing into the prefix any more, and a
          // half-written rung from the attempt that gave up is exactly what should go.
          settled: true,
          renditionNames: asset.renditions.map((r) => r.name),
        };

        try {
          const keys = await this.storage.listKeys(assetPrefix(asset.id));
          for (const key of orphansIn(inventory, keys)) {
            await this.storage.deleteObject(key);
            deleted += 1;
            this.logger.log(`deleted orphaned object ${key}`);
          }
        } catch (error) {
          // One unreachable prefix must not stop the sweep — the next asset may be the
          // one leaking gigabytes.
          this.logger.error(
            `failed to reconcile asset ${asset.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      if (deleted > 0) this.logger.log(`reconciliation removed ${deleted} orphaned object(s)`);
      return deleted;
    } finally {
      this.running = false;
    }
  }
}
