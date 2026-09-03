import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { ConfigType } from '@nestjs/config';
import type { PipelineProgress, DeadLetteredJob } from '@masternova/shared';
import { redisConfig } from '../../config/configuration';
import { AssetNotFoundException } from '../../common/exceptions';
import type { Actor } from '../catalog/actor';
import { MEDIA_REPOSITORY, type IMediaRepository } from './repositories/media.repository.interface';

/**
 * The queue name the worker drains. Duplicated as a literal rather than imported, because
 * the API must not depend on the worker's internals (CLAUDE.md §4) — and a queue name is a
 * wire-level contract between two deployables, like a topic, not a shared implementation.
 */
const PIPELINE_QUEUE = 'media-pipeline';

/** How often the SSE stream polls while a pipeline is running. */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long one stream may stay open before it gives up on its own.
 *
 * A terminal state is not guaranteed to arrive: an IMAGE asset never enters the pipeline and
 * sits at PENDING forever, and a video whose worker died before it could be marked FAILED
 * sits at RUNNING. Without a ceiling each such connection is an unbounded 1 Hz query against
 * Postgres for a bar that will never move. Thirty minutes matches the pipeline's job lock —
 * longer than any legitimate encode, short enough that abandoned readers drain.
 *
 * The client is not stranded: SSE reconnects automatically, so a still-interested browser
 * simply opens a new stream.
 */
const STREAM_MAX_MS = 30 * 60_000;

/**
 * The read side of the transcode pipeline: progress for the wizard, and the dead-letter
 * queue for an operator.
 *
 * **Why the API talks to Redis at all.** Progress could have been served from Postgres
 * alone — the worker already ratchets `pipelinePercent` there, and that is exactly what
 * this streams. Redis is needed only for the DLQ, where BullMQ's failed set already holds
 * the payload, the attempt count and every attempt's stack trace. Copying that into a
 * `dead_letter_jobs` table would be a dual write against state Redis owns, free to
 * disagree with it — the same argument as ADR-0017.
 */
@Injectable()
export class PipelineStatusService implements OnModuleDestroy {
  private readonly logger = new Logger(PipelineStatusService.name);
  private queue?: Queue;

  constructor(
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
    @Inject(MEDIA_REPOSITORY) private readonly media: IMediaRepository,
  ) {}

  /**
   * Connected on first use, not in the constructor.
   *
   * Only the two dead-letter endpoints need Redis; progress is served from Postgres. An
   * eager connection meant every API integration test — none of which touch the DLQ — sat
   * behind an ioredis client retrying a connection that was never going to arrive, keeping
   * the event loop alive between suites. Found by the suite passing alone and failing in
   * the full run, which is the signature of exactly this.
   */
  private get bullQueue(): Queue {
    if (!this.queue) {
      this.queue = new Queue(PIPELINE_QUEUE, {
        connection: { host: this.config.host, port: this.config.port },
      });

      // BullMQ forwards its ioredis connection errors as an EventEmitter 'error', which
      // throws when nothing is listening — so a Redis restart would take the API process
      // down over the DLQ endpoints, which are the two least important routes it serves.
      this.queue.on('error', (error) => {
        this.logger.error(`pipeline queue connection error: ${error.message}`);
      });
    }
    return this.queue;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async progressFor(assetId: string, actor: Actor): Promise<PipelineProgress> {
    const asset = await this.media.findAsset(assetId);
    // Same answer as everywhere else in this module: "not yours" and "does not exist" are
    // indistinguishable, so the endpoint is not an oracle for probing asset ids.
    if (!asset || (asset.ownerId !== actor.id && actor.role !== 'ADMIN')) {
      throw new AssetNotFoundException();
    }

    return {
      assetId: asset.id,
      status: asset.pipeline,
      stage: asset.pipelineStage,
      percent: asset.pipelinePercent,
      error: asset.pipelineError,
      durationSeconds: asset.durationSeconds,
    };
  }

  /**
   * Emits until the pipeline reaches a terminal state, then returns.
   *
   * **Polling Postgres rather than subscribing to BullMQ's events.** `QueueEvents` would
   * push, but it reports *per-job* progress and the wizard wants one number across a
   * five-job DAG — reassembling that in the API would put the DAG's shape in two places.
   * The worker already collapses it into `pipelinePercent`, so a one-second poll of one
   * indexed row is both simpler and correct. It is also what survives a Redis flush.
   *
   * An async generator rather than a callback, so the controller can hand it to Fastify
   * and back-pressure is the transport's problem rather than a buffer of our own.
   *
   * **`signal` is not optional in practice.** The generator only regains control at a
   * `yield`, and it only yields on *change* — so a caller that checks a flag after the loop
   * body cannot stop a stream that has nothing to report. The disconnect has to be visible
   * to the poll itself, which is what the signal makes it.
   */
  async *stream(
    assetId: string,
    actor: Actor,
    signal?: AbortSignal,
  ): AsyncGenerator<PipelineProgress> {
    const deadline = Date.now() + STREAM_MAX_MS;
    let last = '';

    while (!signal?.aborted && Date.now() < deadline) {
      const progress = await this.progressFor(assetId, actor);
      const encoded = JSON.stringify(progress);

      // Only on change: a client watching a ten-minute encode should not receive six
      // hundred identical frames, and an unchanged bar is not news.
      if (encoded !== last) {
        last = encoded;
        yield progress;
      }

      if (progress.status === 'READY' || progress.status === 'FAILED') return;
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  /** What an operator sees: jobs that exhausted every attempt, newest failure first. */
  async deadLettered(limit = 50): Promise<DeadLetteredJob[]> {
    const failed = await this.bullQueue.getFailed(0, limit - 1);

    return failed.map((job) => ({
      id: job.id ?? '',
      type: job.name,
      assetId: (job.data as { assetId?: string })?.assetId ?? null,
      attempts: job.attemptsMade,
      reason: job.failedReason ?? 'unknown',
      failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    }));
  }

  /**
   * Re-run one dead-lettered job.
   *
   * `retry()` moves the existing job back to waiting rather than adding a new one — which
   * matters, because a new job would collide with the original's deterministic id and be
   * silently dropped. The replay would report success and do nothing.
   */
  async replay(jobId: string): Promise<boolean> {
    const job = await this.bullQueue.getJob(jobId);
    if (!job) return false;

    await job.retry();
    this.logger.log(`replayed dead-lettered job ${jobId}`);
    return true;
  }
}

/**
 * A sleep the abort signal can cut short.
 *
 * A bare `setTimeout` would hold the poll for its full second after the client has gone, and
 * — more to the point — keeps a timer on the event loop that delays a graceful shutdown.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
