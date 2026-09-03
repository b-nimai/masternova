import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { PipelineJob, type ProbeJobPayload } from '@masternova/contracts';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import { JobProcessor } from '../../../common/decorators/job-processor.decorator';
import {
  BaseJobProcessor,
  UnrecoverableJobError,
  type JobContext,
} from '../jobs/base-job.processor';
import { MEDIA_TOOLS, type IMediaTools } from '../ffmpeg/ffmpeg.interface';
import { ladderFor } from '../ladder/transcode-profile';
import { JobQueueService } from '../queue/job-queue.service';
import {
  PIPELINE_REPOSITORY,
  type IPipelineRepository,
} from '../repositories/pipeline.repository.interface';
import { sourceKey } from '../output-keys';
import { overallPercent, stageLabel } from '../pipeline-progress';

/**
 * Stage 1 — read the source, and decide what the rest of the pipeline will do.
 *
 * This is the only stage that *chooses* anything: the ABR ladder depends on the source
 * resolution, and nothing knows it until ffprobe has run. Everything downstream is handed
 * its decision rather than re-deriving it, so a job replayed a week later cannot silently
 * encode a different set of rungs than its siblings did.
 */
@JobProcessor(PipelineJob.Probe)
export class ProbeProcessor extends BaseJobProcessor<ProbeJobPayload> {
  readonly jobType = PipelineJob.Probe;
  protected readonly schema = z.object({ assetId: z.string().min(1) });

  constructor(
    @Inject(PIPELINE_REPOSITORY) private readonly repo: IPipelineRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(MEDIA_TOOLS) private readonly tools: IMediaTools,
    private readonly queue: JobQueueService,
  ) {
    super();
  }

  protected async execute(payload: ProbeJobPayload, ctx: JobContext): Promise<void> {
    const asset = await this.repo.findAsset(payload.assetId);
    // Not retryable: the asset was deleted, or the id was never real. Retrying re-reads the
    // same missing row four more times and then dead-letters anyway.
    if (!asset) throw new UnrecoverableJobError(`asset ${payload.assetId} does not exist`);

    // Only video is transcoded. An image or an attachment reaching here is a bug in the
    // handler that enqueued it, not a transient failure.
    if (asset.kind !== 'VIDEO') {
      throw new UnrecoverableJobError(`asset ${asset.id} is ${asset.kind}, not VIDEO`);
    }

    await this.repo.setPipeline(asset.id, 'RUNNING', {
      stage: stageLabel(PipelineJob.Probe),
      percent: 0,
      error: null,
    });

    // ffmpeg speaks HTTP, so the source is streamed and decoded as it arrives — a 10 GB
    // lecture never touches the worker's disk.
    const url = await this.storage.presignDownload(sourceKey(asset.id));
    const probed = await this.tools.probe(url);

    await this.repo.recordProbe(asset.id, probed.durationSeconds);
    await ctx.report(1);

    const rungs = ladderFor(probed.height).map((profile) => profile.name);

    await this.queue.enqueueFanout({
      assetId: asset.id,
      rungs,
      posterAtSeconds: posterOffset(probed.durationSeconds),
      durationSeconds: probed.durationSeconds,
    });

    await this.repo.advanceProgress(
      asset.id,
      overallPercent(PipelineJob.Probe, 1),
      stageLabel(PipelineJob.Transcode),
    );

    this.logger.log(
      `probed ${asset.id}: ${probed.width}x${probed.height}, ${Math.round(probed.durationSeconds)}s → rungs ${rungs.join(', ')}`,
    );
  }

  /**
   * Deliberately **not** overridden to skip on a re-probe.
   *
   * A redelivered probe re-reads the source and re-enqueues the fan-out — and that is
   * harmless, because every child carries a deterministic `jobId` that BullMQ refuses to
   * add twice. Skipping when `durationSeconds` is already set would instead be actively
   * wrong: it is the path a DLQ replay takes after the fan-out failed to enqueue, and
   * skipping would leave the asset probed forever and never encoded.
   */
}

/**
 * Where to grab the poster frame.
 *
 * A frame from 10% in, not from 0: the first frame of a lecture recording is reliably a
 * black screen or a half-drawn slide, which makes a poor course card.
 *
 * The clamp has to be `min` on the *outside*. Written the other way round the 1-second floor
 * overrides the upper bound for anything shorter than ~1.1s, so a 1-second source seeks to
 * exactly its duration — ffmpeg's `-ss` lands past the last frame, `-frames:v 1` writes
 * nothing, and the poster job fails on a `readFile` ENOENT that is not recognisably fatal
 * and so burns all five attempts before dead-lettering the flow's parent with it.
 */
export function posterOffset(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  // Half a frame short of the end at 30fps, so the seek is always inside the media.
  const latest = Math.max(0, durationSeconds - 0.05);
  return Math.min(Math.max(durationSeconds * 0.1, 1), latest);
}
