import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { PipelineJob, type TranscodeJobPayload } from '@masternova/contracts';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import { JobProcessor } from '../../../common/decorators/job-processor.decorator';
import {
  BaseJobProcessor,
  UnrecoverableJobError,
  type JobContext,
} from '../jobs/base-job.processor';
import { MEDIA_TOOLS, type IMediaTools } from '../ffmpeg/ffmpeg.interface';
import { HlsCommandBuilder } from '../ffmpeg/hls-command.builder';
import { ladderFor, profileFor, widthFor } from '../ladder/transcode-profile';
import {
  PIPELINE_REPOSITORY,
  type IPipelineRepository,
} from '../repositories/pipeline.repository.interface';
import { segmentKey, sourceKey, variantPlaylistKey } from '../output-keys';
import { overallPercent, stageLabel } from '../pipeline-progress';

/**
 * Stage 2 — encode one rung of the ABR ladder into HLS.
 *
 * One rung per job, not one job for the whole ladder. The ladder is the fan-out: four rungs
 * on four workers finish in the time of the slowest, and a 1080p rung that fails is retried
 * alone rather than re-encoding the three that already succeeded. It is also what makes the
 * queue-depth signal meaningful — a backlog of rungs is work the autoscaler can act on.
 */
@JobProcessor(PipelineJob.Transcode)
export class TranscodeProcessor extends BaseJobProcessor<TranscodeJobPayload> {
  readonly jobType = PipelineJob.Transcode;
  protected readonly schema = z.object({
    assetId: z.string().min(1),
    rung: z.string().min(1),
  });

  constructor(
    @Inject(PIPELINE_REPOSITORY) private readonly repo: IPipelineRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(MEDIA_TOOLS) private readonly tools: IMediaTools,
  ) {
    super();
  }

  /**
   * Skips only when the rendition row already exists.
   *
   * The row is written *after* every segment has been uploaded, so its presence means the
   * rung is genuinely complete. A worker killed mid-encode leaves no row, and the
   * redelivery re-encodes from scratch — which is correct, because the segments it had
   * written are overwritten by the same deterministic keys rather than duplicated.
   */
  protected async isAlreadyDone(payload: TranscodeJobPayload): Promise<boolean> {
    return (await this.repo.findRendition(payload.assetId, payload.rung)) !== null;
  }

  protected async execute(payload: TranscodeJobPayload, ctx: JobContext): Promise<void> {
    const asset = await this.repo.findAsset(payload.assetId);
    if (!asset) throw new UnrecoverableJobError(`asset ${payload.assetId} does not exist`);

    const profile = profileFor(payload.rung);
    // The ladder changed between this job being queued and being run — a deploy, most
    // likely. Retrying cannot bring the rung back, so it goes straight to the DLQ where
    // someone can decide whether to re-run the asset against the new ladder.
    if (!profile) {
      throw new UnrecoverableJobError(`rung ${payload.rung} is not in the current ABR ladder`);
    }

    const url = await this.storage.presignDownload(sourceKey(asset.id));
    const probed = await this.tools.probe(url);

    const workDir = await mkdtemp(join(tmpdir(), `mn-${asset.id}-${payload.rung}-`));
    try {
      const args = HlsCommandBuilder.for({
        inputUrl: url,
        profile,
        sourceWidth: probed.width,
        sourceHeight: probed.height,
        outputDir: workDir,
      }).build();

      const rungs = ladderFor(probed.height).map((p) => p.name);
      const index = Math.max(0, rungs.indexOf(payload.rung));

      await this.tools.run(args, probed.durationSeconds, (fraction) => {
        // Fire-and-forget: a progress write must never be able to fail an encode that is
        // otherwise going fine.
        void ctx.report(fraction).catch(() => undefined);
        void this.repo
          .advanceProgress(
            asset.id,
            overallPercent(PipelineJob.Transcode, fraction, { index, count: rungs.length }),
            stageLabel(PipelineJob.Transcode, payload.rung),
          )
          .catch(() => undefined);
      });

      const uploaded = await this.upload(asset.id, payload.rung, workDir);

      // Written last, and that ordering is the idempotency contract: the row means every
      // byte is in the bucket. Writing it first would let a crash mid-upload leave a rung
      // that `isAlreadyDone` reports as finished and the master playlist then points at.
      await this.repo.upsertRendition({
        assetId: asset.id,
        kind: 'VIDEO',
        name: payload.rung,
        storageKey: variantPlaylistKey(asset.id, payload.rung),
        sizeBytes: uploaded,
        width: widthFor(profile, probed.width, probed.height),
        height: profile.height,
        bitrateBps: profile.videoBitrateBps,
      });
    } finally {
      // Always, including on failure: a worker that leaks a temp directory per failed
      // attempt fills its disk and then fails every subsequent job for an unrelated reason.
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Segments first, playlist last — the same reason the row is written last. */
  private async upload(assetId: string, rung: string, workDir: string): Promise<bigint> {
    const files = await readdir(workDir);
    const segments = files.filter((name) => name.endsWith('.ts')).sort();

    let total = 0n;
    for (const segment of segments) {
      const path = join(workDir, segment);
      const body = await readFile(path);
      await this.storage.putObject(segmentKey(assetId, rung, segment), body, 'video/mp2t');
      total += BigInt((await stat(path)).size);
    }

    // A playlist referencing a segment that is not there yet is a player error; a segment
    // no playlist references yet is invisible. So the playlist goes up last.
    const playlist = await readFile(join(workDir, 'index.m3u8'));
    await this.storage.putObject(
      variantPlaylistKey(assetId, rung),
      playlist,
      'application/vnd.apple.mpegurl',
    );

    return total + BigInt(playlist.byteLength);
  }
}
