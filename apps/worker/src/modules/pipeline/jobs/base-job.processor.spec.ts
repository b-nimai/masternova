import { z } from 'zod';
import { PipelineJob } from '@masternova/contracts';
import { BaseJobProcessor, UnrecoverableJobError, type JobContext } from './base-job.processor';
import { JobProcessorRegistry } from './job-processor.registry';

const ctx = (): JobContext => ({ attempt: 1, report: () => Promise.resolve() });

class SpyProcessor extends BaseJobProcessor<{ assetId: string }> {
  readonly jobType = PipelineJob.Probe;
  protected readonly schema = z.object({ assetId: z.string().min(1) });

  executed: { assetId: string }[] = [];
  done = false;

  protected execute(payload: { assetId: string }): Promise<void> {
    this.executed.push(payload);
    return Promise.resolve();
  }

  protected isAlreadyDone(): Promise<boolean> {
    return Promise.resolve(this.done);
  }
}

class ExplodingProcessor extends BaseJobProcessor<{ assetId: string }> {
  readonly jobType = PipelineJob.Transcode;
  protected readonly schema = z.object({ assetId: z.string() });
  protected execute(): Promise<void> {
    return Promise.reject(new Error('ffmpeg exited with code 1'));
  }
}

/** No queue, no Redis, no ffmpeg. The template is control flow, so the tests are too. */
describe('BaseJobProcessor', () => {
  it('parses the payload before running the step', async () => {
    const processor = new SpyProcessor();
    await processor.process({ assetId: 'asset-1' }, ctx());
    expect(processor.executed).toEqual([{ assetId: 'asset-1' }]);
  });

  /**
   * A message that can never parse must not be retried. Without this it burns every attempt
   * and the better part of an hour of backoff before reaching the dead-letter set.
   */
  it('rejects a malformed payload as unrecoverable, without executing', async () => {
    const processor = new SpyProcessor();
    await expect(processor.process({ assetId: '' }, ctx())).rejects.toBeInstanceOf(
      UnrecoverableJobError,
    );
    await expect(processor.process({ wrong: true }, ctx())).rejects.toBeInstanceOf(
      UnrecoverableJobError,
    );
    expect(processor.executed).toEqual([]);
  });

  it('names the offending field, so a DLQ entry explains itself', async () => {
    const processor = new SpyProcessor();
    await expect(processor.process({}, ctx())).rejects.toThrow(/assetId/);
  });

  /**
   * BullMQ delivers at-least-once: a worker SIGKILLed mid-transcode *will* have its job
   * redelivered. The hook is what makes that a no-op rather than duplicate work.
   */
  it('skips the step when the processor reports the work is already done', async () => {
    const processor = new SpyProcessor();
    processor.done = true;
    await processor.process({ assetId: 'asset-1' }, ctx());
    expect(processor.executed).toEqual([]);
  });

  /**
   * A processor that does not override the hook redoes the work, and that is the correct
   * default: every output key in this pipeline is deterministic, so a redo overwrites its
   * own output rather than duplicating it. "Do it again" is the safe wrong answer.
   */
  it('defaults to redoing the work, because every output key is deterministic', async () => {
    class NoOverride extends BaseJobProcessor<{ assetId: string }> {
      readonly jobType = PipelineJob.Poster;
      protected readonly schema = z.object({ assetId: z.string() });
      runs = 0;
      protected execute(): Promise<void> {
        this.runs += 1;
        return Promise.resolve();
      }
    }

    const processor = new NoOverride();
    await processor.process({ assetId: 'a' }, ctx());
    await processor.process({ assetId: 'a' }, ctx());
    expect(processor.runs).toBe(2);
  });

  it('lets a step’s failure propagate, so the queue can retry it', async () => {
    await expect(new ExplodingProcessor().process({ assetId: 'a' }, ctx())).rejects.toThrow(
      /ffmpeg exited/,
    );
  });
});

describe('JobProcessorRegistry (Factory Method)', () => {
  it('resolves a processor by job type', () => {
    const registry = new JobProcessorRegistry();
    const probe = new SpyProcessor();
    registry.register(probe as never);
    expect(registry.resolve(PipelineJob.Probe)).toBe(probe);
  });

  /**
   * `undefined`, not a throw: the queue worker decides whether an unknown type is deploy
   * skew (retry — the processor may exist on the next pod) or a dead message.
   */
  it('returns undefined for a type nothing registered', () => {
    expect(new JobProcessorRegistry().resolve(PipelineJob.Sprite)).toBeUndefined();
  });

  /** The second would silently shadow the first, and the symptom is a stage that stopped. */
  it('refuses two processors claiming the same job type', () => {
    const registry = new JobProcessorRegistry();
    registry.register(new SpyProcessor() as never);
    expect(() => registry.register(new SpyProcessor() as never)).toThrow(/two processors/);
  });

  it('reports what it registered, so boot logs and health checks can assert it', () => {
    const registry = new JobProcessorRegistry();
    registry.register(new SpyProcessor() as never, new ExplodingProcessor() as never);
    expect(registry.registeredTypes()).toEqual([PipelineJob.Probe, PipelineJob.Transcode].sort());
  });
});
