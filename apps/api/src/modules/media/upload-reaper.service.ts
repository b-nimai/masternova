import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { UploadCompletionService } from './upload-completion.service';
import { MEDIA_REPOSITORY, type IMediaRepository } from './repositories/media.repository.interface';

const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Bounded so one sweep after an outage is a predictable amount of provider traffic. */
const SWEEP_BATCH = 50;

/**
 * How long a session may sit in COMPLETING before the sweep treats it as abandoned.
 *
 * Longer than the grace `UploadCompletionService` applies to a client retry, because the
 * reaper has no user waiting on it and the cost of being wrong is higher: releasing a claim
 * whose assemble is genuinely still running is the race that produced zero successes out of
 * ten in testing. Ten minutes is far beyond any real assemble, which only stitches metadata.
 */
const STALLED_ASSEMBLE_MS = 10 * 60_000;

/**
 * Reclaims uploads that were started and never finished.
 *
 * **Why this is not optional.** An abandoned multipart upload is storage you are billed
 * for and cannot see: the parts do not appear in a bucket listing, and there is no object
 * to delete. A tab closed on a 10 GB upload leaves 10 GB of invisible cost behind, and
 * without a sweep the only evidence is the monthly bill.
 *
 * **Why it is safe to run in every API replica.** It does not coordinate, and does not need
 * to: `end()` claims each row with a conditional transition, so N replicas sweeping the
 * same batch produce exactly one winner per session and N−1 no-ops. That is cheaper than a
 * leader election and has one fewer thing to go wrong.
 *
 * **The seam.** This is a poll loop in the request-serving deployable, which is the wrong
 * home for it — the outbox relay makes the same argument and lives in the worker. It stays
 * here only because the worker has no job scheduler until task 1.7; when `BaseJobProcessor`
 * lands, the trigger moves and `sweep()` is what the job calls. Nothing else changes.
 */
@Injectable()
export class UploadReaperService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UploadReaperService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: IMediaRepository,
    private readonly completion: UploadCompletionService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // Node keeps the process alive for a pending timer; this one must not hold a shutdown.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One sweep. Guarded against overlapping itself, so a slow batch cannot compound into
   * two concurrent sweeps in the same replica.
   *
   * Returns the number of sessions it actually claimed — which is what the integration
   * test asserts, and what a metric would export.
   */
  async sweep(now = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    let recovered = 0;
    let released = 0;

    try {
      let reaped = 0;

      const expired = await this.media.findExpired(now, SWEEP_BATCH);
      for (const session of expired) {
        try {
          // Counted only when the conditional transition actually matched. Every replica
          // sweeps the same batch, so incrementing unconditionally would have each of them
          // report the full batch and overstate the metric N-fold.
          if (await this.completion.end(session, 'EXPIRED', 'expired')) reaped += 1;
        } catch (error) {
          // One bad session must not stop the sweep — the next one may be the 10 GB leak.
          this.logger.error(
            `failed to reap upload ${session.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      /**
       * Sessions stranded mid-assemble, which no other path can reach.
       *
       * `findExpired` deliberately skips COMPLETING and `abort` refuses it, so a session
       * whose process died and whose client never came back would otherwise sit there
       * forever — parts billed, invisible in a bucket listing, asset stuck PENDING. That is
       * exactly the leak this service exists to prevent, so it has to be swept too.
       *
       * They are *resolved*, not aborted: the object may already exist, and `recover()`
       * asks the provider rather than guessing. A 409 from it is the ordinary outcome —
       * the session was released back to UPLOADING and normal expiry will collect it.
       */
      const stalled = await this.media.findStalledCompleting(
        new Date(now.getTime() - STALLED_ASSEMBLE_MS),
        SWEEP_BATCH,
      );
      for (const session of stalled) {
        try {
          await this.completion.recover(session);
          recovered += 1;
        } catch {
          // Released to UPLOADING, which is the expected path when no object was assembled.
          released += 1;
        }
      }

      if (reaped > 0) this.logger.log(`reaped ${reaped} expired upload session(s)`);
      if (recovered > 0 || released > 0) {
        this.logger.log(`stalled assembles: ${recovered} recovered, ${released} released`);
      }
      return reaped;
    } finally {
      this.running = false;
    }
  }
}
