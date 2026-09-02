import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { ConfigType } from '@nestjs/config';
import type { PipelineJobType } from '@masternova/contracts';
import { redisConfig } from '../../../config/configuration';
import { JobProcessorRegistry } from '../jobs/job-processor.registry';
import { UnrecoverableJobError, type JobContext } from '../jobs/base-job.processor';
import { PIPELINE_CONCURRENCY, PIPELINE_LOCK_MS, PIPELINE_QUEUE } from './queue.config';

/**
 * Drains the pipeline queue and hands each job to the processor that claims its type.
 *
 * It knows nothing about probing, transcoding or packaging — the registry resolves the
 * processor and the Template Method runs it. That is the payoff of the Factory Method: this
 * file did not change when the sprite stage was added and will not change for task 1.16's
 * transcription stage.
 */
@Injectable()
export class PipelineWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PipelineWorker.name);
  private worker?: Worker;

  constructor(
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
    private readonly registry: JobProcessorRegistry,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker(PIPELINE_QUEUE, (job) => this.run(job), {
      connection: { host: this.config.host, port: this.config.port },
      concurrency: PIPELINE_CONCURRENCY,
      lockDuration: PIPELINE_LOCK_MS,
    });

    // BullMQ swallows a handler that throws asynchronously unless something listens, and a
    // silently dead worker looks exactly like an empty queue.
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `job ${job?.id ?? '?'} (${job?.name ?? '?'}) failed on attempt ${job?.attemptsMade ?? 0}: ${error.message}`,
      );
    });

    this.logger.log(
      `pipeline worker draining "${PIPELINE_QUEUE}" (concurrency ${PIPELINE_CONCURRENCY}) for: ${this.registry.registeredTypes().join(', ')}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    // `close()` waits for in-flight jobs rather than killing them, so a rolling deploy does
    // not orphan a half-written rendition. The processors are idempotent either way, but
    // finishing is cheaper than redoing.
    await this.worker?.close();
  }

  private async run(job: Job): Promise<void> {
    const processor = this.registry.resolve(job.name as PipelineJobType);

    if (!processor) {
      // Deliberately retryable. The usual cause is deploy skew — this pod is older than the
      // one that queued the job — and the next attempt may well land on a pod that has the
      // processor. If it is genuinely unknown, it dead-letters after the normal attempts.
      throw new Error(`no processor registered for job type "${job.name}"`);
    }

    const ctx: JobContext = {
      attempt: job.attemptsMade + 1,
      report: (fraction) => job.updateProgress(Math.round(fraction * 100)),
    };

    try {
      await processor.process(job.data, ctx);
    } catch (error) {
      // Translate our "this can never succeed" into BullMQ's, so it skips the remaining
      // attempts and dead-letters immediately. Without this a malformed payload burns five
      // attempts and two and a half minutes of backoff to reach the same place.
      if (error instanceof UnrecoverableJobError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
