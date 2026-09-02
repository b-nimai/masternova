import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { FlowProducer, Queue, type FlowJob, type JobNode } from 'bullmq';
import type { ConfigType } from '@nestjs/config';
import { PipelineJob, type PipelineJobType } from '@masternova/contracts';
import { redisConfig } from '../../../config/configuration';
import { PIPELINE_JOB_OPTIONS, PIPELINE_QUEUE } from './queue.config';

/** One rung of the fan-out, plus the two artifacts that do not depend on the ladder. */
export interface PipelineFanout {
  readonly assetId: string;
  readonly rungs: readonly string[];
  readonly posterAtSeconds: number;
  readonly durationSeconds: number;
}

/**
 * Enqueues pipeline work, including the fan-out DAG.
 *
 * **Why the DAG is built after probe, not upfront.** The ladder depends on the source
 * resolution — a 480p upload produces two rungs and a 4K upload produces four — and nothing
 * knows that until ffprobe has run. So probe is enqueued alone, and its completion builds
 * the rest. Constructing the flow upfront would mean guessing the ladder and then
 * cancelling the rungs that turned out to be upscales.
 *
 * **Why a BullMQ flow rather than counting completions ourselves.** The packaging step must
 * run once, after *every* rung has landed. Doing that by hand means a counter somewhere and
 * a decision about who increments it — and two rungs finishing simultaneously either
 * double-fire the packager or lose the increment. A flow makes "parent waits for children"
 * the queue's problem, which is where the atomic primitive already lives.
 */
@Injectable()
export class JobQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly queue: Queue;
  private readonly flows: FlowProducer;

  constructor(@Inject(redisConfig.KEY) config: ConfigType<typeof redisConfig>) {
    const connection = { host: config.host, port: config.port };
    this.queue = new Queue(PIPELINE_QUEUE, { connection });
    this.flows = new FlowProducer({ connection });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.queue.close(), this.flows.close()]);
  }

  /**
   * The pipeline's entry point, enqueued when `media.asset.ready` arrives.
   *
   * **`jobId` is the asset id, and that is the dedupe.** BullMQ refuses a second job with an
   * id already in the queue, so the outbox relay delivering the same event twice — which it
   * is explicitly allowed to do, delivery being at-least-once — enqueues one probe. This is
   * the idea Loom's dropped `queue` module carried, recorded against this task in §2.2.
   */
  async enqueueProbe(assetId: string): Promise<void> {
    await this.queue.add(
      PipelineJob.Probe,
      { assetId },
      { ...PIPELINE_JOB_OPTIONS, jobId: `probe:${assetId}` },
    );
    this.logger.log(`queued probe for asset ${assetId}`);
  }

  /**
   * The fan-out: every rung, the poster and the sprite run in parallel, and the master
   * playlist is written only once all of them are done.
   *
   * Poster and sprite are children of the packager rather than siblings enqueued separately
   * — not because packaging needs them, but because "the asset is playable" should mean
   * *everything* is there. A lecture that plays but has no thumbnail is a half-finished
   * state the wizard would have to model, and modelling it is worse than waiting for it.
   */
  async enqueueFanout(fanout: PipelineFanout): Promise<void> {
    const { assetId, rungs } = fanout;

    const children: FlowJob[] = [
      ...rungs.map((rung) =>
        this.child(PipelineJob.Transcode, `transcode:${assetId}:${rung}`, { assetId, rung }),
      ),
      this.child(PipelineJob.Poster, `poster:${assetId}`, {
        assetId,
        atSeconds: fanout.posterAtSeconds,
      }),
      this.child(PipelineJob.Sprite, `sprite:${assetId}`, {
        assetId,
        durationSeconds: fanout.durationSeconds,
      }),
    ];

    await this.flows.add({
      name: PipelineJob.Package,
      queueName: PIPELINE_QUEUE,
      data: { assetId, rungs },
      opts: { ...PIPELINE_JOB_OPTIONS, jobId: `package:${assetId}` },
      children,
    });

    this.logger.log(`queued ${rungs.length} rung(s) + poster + sprite for asset ${assetId}`);
  }

  private child(name: PipelineJobType, jobId: string, data: object): FlowJob {
    return {
      name,
      queueName: PIPELINE_QUEUE,
      data,
      // Deterministic child ids for the same reason as the probe: a redelivered parent
      // event must not fan out a second copy of a ladder that is already encoding.
      opts: { ...PIPELINE_JOB_OPTIONS, jobId },
    };
  }

  /** The dead-letter set: jobs that exhausted every attempt. Drives the replay endpoint. */
  async deadLettered(
    limit = 50,
  ): Promise<{ id: string; name: string; data: unknown; reason: string }[]> {
    const failed = await this.queue.getFailed(0, limit - 1);
    return failed.map((job) => ({
      id: job.id ?? '',
      name: job.name,
      data: job.data as unknown,
      reason: job.failedReason ?? 'unknown',
    }));
  }

  /**
   * Re-run one dead-lettered job.
   *
   * `retry()` moves the existing job back to waiting rather than adding a new one, which
   * matters: adding a copy would collide with the original's deterministic `jobId` and be
   * silently dropped, so the replay would look like it worked and do nothing.
   */
  async replay(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    await job.retry();
    this.logger.log(`replayed dead-lettered job ${jobId}`);
    return true;
  }

  /** Exposed for the integration tests, which need to observe the flow tree BullMQ built. */
  flowTree(jobId: string): Promise<JobNode | null> {
    return this.flows.getFlow({ id: jobId, queueName: PIPELINE_QUEUE });
  }
}
