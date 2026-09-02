import { Logger } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import type { PipelineJobType } from '@masternova/contracts';

/**
 * What a processor is told about the job it is running, beyond its payload.
 *
 * `report` is how a long step drives the wizard's progress bar. It is on the context rather
 * than injected because it is scoped to *this* job — a processor holding an injected
 * reporter would have to be told which job it was reporting for, which is the same thing
 * with more chances to get it wrong.
 */
export interface JobContext {
  readonly attempt: number;
  /** 0–1 within this job. The orchestrator maps it onto the DAG's overall percentage. */
  report(fraction: number): Promise<void>;
}

/**
 * The fixed skeleton every pipeline job runs, as **Template Method**:
 * `validate → skipIfDone → execute → persist`.
 *
 * **The force.** Five processors share four obligations that are easy to get individually
 * right and collectively inconsistent. Every one of them must reject a malformed payload
 * before touching ffmpeg; every one must be safe to run twice, because BullMQ delivers
 * at-least-once and a worker SIGKILLed mid-transcode *will* have its job redelivered; every
 * one must record what it produced; and every one must fail in a way the DLQ can explain.
 * Left to convention, the fourth processor forgets the idempotency check — and the symptom
 * is duplicate renditions and orphaned S3 objects that only appear under a restart.
 *
 * **What varies, and is therefore abstract:** what the job *does* (`execute`) and what
 * "already done" means for it (`isAlreadyDone`). Everything else is fixed here.
 *
 * **Why this is a base class and not a decorator or a middleware chain.** CLAUDE.md §3 says
 * inheritance only for a genuine `is-a` with a stable contract. Every pipeline job *is* a
 * pipeline job in exactly this sense: the four steps are not optional and their order is
 * not negotiable. This is the one place in the project that clears that bar — and it was
 * deliberately deferred from task 1.1, where it would have had zero subclasses and been the
 * speculative generality §3 forbids.
 */
export abstract class BaseJobProcessor<TPayload> {
  protected readonly logger = new Logger(this.constructor.name);

  abstract readonly jobType: PipelineJobType;

  /** Parsed, not cast. A payload is JSON off a queue and a JSON column is not a type. */
  protected abstract readonly schema: ZodSchema<TPayload>;

  /**
   * The step's actual work. The only method a processor is required to think hard about.
   */
  protected abstract execute(payload: TPayload, ctx: JobContext): Promise<void>;

  /**
   * **The idempotency hook, and the reason this class exists.**
   *
   * Delivery is at-least-once, so this runs for every redelivery — a worker killed
   * mid-transcode, a visibility timeout that expired while ffmpeg was still going, an
   * operator replaying a DLQ entry. Returning `true` makes the redelivery a no-op.
   *
   * Default is `false` — "do the work again" — because that is the *safe* wrong answer.
   * Every output key in this pipeline is deterministic, so redoing a step overwrites its own
   * output rather than duplicating it. A processor overrides this only to save the cost of
   * that redo, never to preserve correctness.
   */
  protected isAlreadyDone(_payload: TPayload): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * The invariant sequence. Not overridable — a processor that needed to reorder these
   * would be telling you it is not a pipeline job.
   */
  async process(raw: unknown, ctx: JobContext): Promise<void> {
    const payload = this.validate(raw);

    if (await this.isAlreadyDone(payload)) {
      this.logger.debug(`${this.jobType}: already done, skipping`);
      return;
    }

    const startedAt = Date.now();
    await this.execute(payload, ctx);
    this.logger.log(`${this.jobType} finished in ${Date.now() - startedAt}ms`);
  }

  /**
   * A malformed payload is not retryable, and saying so matters: BullMQ would otherwise
   * back off and retry a message that can never succeed, burning eight attempts and the
   * better part of an hour before it reaches the DLQ.
   */
  private validate(raw: unknown): TPayload {
    const result = this.schema.safeParse(raw);
    if (!result.success) {
      throw new UnrecoverableJobError(
        `${this.jobType}: malformed payload — ${result.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
      );
    }
    return result.data;
  }
}

/**
 * A failure that retrying cannot fix: a malformed payload, a source with no video stream,
 * a rung that no longer exists in the ladder.
 *
 * Distinguished from an ordinary error because the response is different. A transient S3
 * blip should be retried with backoff; a message that will never parse should go straight
 * to the dead-letter set, where a human can look at it. Retrying the second kind is how a
 * queue fills up with work that is guaranteed to fail.
 */
export class UnrecoverableJobError extends Error {
  readonly unrecoverable = true;

  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableJobError';
  }
}
