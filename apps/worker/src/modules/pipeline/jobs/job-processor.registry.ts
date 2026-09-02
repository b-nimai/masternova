import { Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import type { PipelineJobType } from '@masternova/contracts';
import { JOB_PROCESSOR_METADATA } from '../../../common/decorators/job-processor.decorator';
import type { BaseJobProcessor } from './base-job.processor';

/**
 * Resolves the processor for a job type, as **Factory Method**.
 *
 * **The force.** One BullMQ worker drains one queue carrying five kinds of job, so
 * something has to turn a type discriminator into the object that handles it. The obvious
 * implementation is a `switch` in the worker's callback — which means the worker imports
 * every processor, and adding task 1.16's transcription stage edits the file that every
 * existing stage depends on. That is exactly what CLAUDE.md §1 O forbids.
 *
 * Discovery instead: a processor declares its own type with `@JobProcessor(...)` and is
 * found wherever it lives. The worker learns nothing about which stages exist.
 *
 * **Why one queue and not one per job type.** A queue per type gives each stage its own
 * concurrency knob, which sounds better and is worse here: the workers are one autoscaled
 * pool sized on total CPU, and five queues means five sets of idle connections plus a
 * scaling signal split five ways. One queue with a type discriminator keeps queue depth a
 * single number — the number the autoscaler in task 2.6 actually scales on.
 *
 * Registration happens at `onApplicationBootstrap` rather than in the constructor because
 * that is the first point at which every provider has an instance.
 */
@Injectable()
export class JobProcessorRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobProcessorRegistry.name);
  private readonly byType = new Map<string, BaseJobProcessor<unknown>>();

  constructor(
    @Optional() private readonly discovery?: DiscoveryService,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.discovery || !this.reflector) return;

    const found = this.discovery
      .getProviders()
      .filter((wrapper) => wrapper.metatype && wrapper.instance)
      .filter((wrapper) => this.reflector?.get(JOB_PROCESSOR_METADATA, wrapper.metatype!))
      .map((wrapper) => wrapper.instance as BaseJobProcessor<unknown>);

    this.register(...found);
    this.logger.log(`registered ${found.length} job processor(s)`);
  }

  /**
   * Public so a test can build a registry with exactly the processors it wants to reason
   * about, with no DI container involved.
   *
   * Two processors claiming one type is a programming error, not a runtime condition — the
   * second would silently shadow the first and the symptom would be a stage that stopped
   * running. It throws at boot, where it is cheap to notice.
   */
  register(...processors: BaseJobProcessor<unknown>[]): void {
    for (const processor of processors) {
      if (this.byType.has(processor.jobType)) {
        throw new Error(`two processors registered for job type ${processor.jobType}`);
      }
      this.byType.set(processor.jobType, processor);
    }
  }

  /**
   * `undefined` rather than a throw: the caller is the queue worker, and it has to decide
   * whether an unknown type is a deploy skew (retry — the processor may exist on the next
   * pod) or a genuinely dead message (dead-letter it). That is not this class's decision.
   */
  resolve(type: PipelineJobType | string): BaseJobProcessor<unknown> | undefined {
    return this.byType.get(type);
  }

  /** What the worker logs at boot, and what a health check can assert. */
  registeredTypes(): string[] {
    return [...this.byType.keys()].sort();
  }
}
