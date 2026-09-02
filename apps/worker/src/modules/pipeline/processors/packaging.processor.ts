import { Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  PipelineEvent,
  PipelineJob,
  UNIT_OF_WORK,
  type PackageJobPayload,
  type UnitOfWork,
} from '@masternova/contracts';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import { JobProcessor } from '../../../common/decorators/job-processor.decorator';
import { BaseJobProcessor, UnrecoverableJobError } from '../jobs/base-job.processor';
import { profileFor } from '../ladder/transcode-profile';
import {
  PIPELINE_REPOSITORY,
  type IPipelineRepository,
} from '../repositories/pipeline.repository.interface';
import { MASTER_RENDITION, masterPlaylistKey, variantPlaylistKey } from '../output-keys';
import { overallPercent, stageLabel } from '../pipeline-progress';

/**
 * Stage 3 — write the HLS master playlist, and declare the asset playable.
 *
 * It is the flow's **parent job**, so BullMQ runs it only once every rung, the poster and
 * the sprite have completed. That is the whole reason for using a flow rather than counting
 * completions by hand: two rungs finishing in the same millisecond would otherwise either
 * double-fire this or lose an increment.
 */
@JobProcessor(PipelineJob.Package)
export class PackagingProcessor extends BaseJobProcessor<PackageJobPayload> {
  readonly jobType = PipelineJob.Package;
  protected readonly schema = z.object({
    assetId: z.string().min(1),
    rungs: z.array(z.string().min(1)).min(1),
  });

  constructor(
    @Inject(PIPELINE_REPOSITORY) private readonly repo: IPipelineRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {
    super();
  }

  protected async execute(payload: PackageJobPayload): Promise<void> {
    const asset = await this.repo.findAsset(payload.assetId);
    if (!asset) throw new UnrecoverableJobError(`asset ${payload.assetId} does not exist`);

    const renditions = await this.repo.listRenditions(asset.id);
    const present = new Set(renditions.map((r) => r.name));

    // Belt and braces over the flow's own ordering. BullMQ guarantees the children finished,
    // not that they *succeeded* in the sense this cares about — and a master listing a rung
    // whose playlist is missing is a player error on the learner's side, which is the
    // worst place to discover it.
    const missing = payload.rungs.filter((rung) => !present.has(rung));
    if (missing.length > 0) {
      throw new Error(`cannot package: rungs not yet rendered — ${missing.join(', ')}`);
    }

    const master = this.buildMaster(asset.id, payload.rungs, renditions);
    const body = Buffer.from(master, 'utf8');
    await this.storage.putObject(
      masterPlaylistKey(asset.id),
      body,
      'application/vnd.apple.mpegurl',
    );

    await this.repo.upsertRendition({
      assetId: asset.id,
      kind: 'MASTER',
      name: MASTER_RENDITION,
      storageKey: masterPlaylistKey(asset.id),
      sizeBytes: BigInt(body.byteLength),
    });

    // The state change and the event commit together. An asset marked playable with no
    // `media.asset.playable` in the outbox is a lecture nothing downstream ever hears about
    // — no instructor email, no search index entry — and it is invisible until someone asks
    // why the course never appeared.
    await this.uow.execute(async (ctx) => {
      await this.repo.setPipeline(asset.id, 'READY', {
        stage: stageLabel(PipelineJob.Package),
        percent: overallPercent(PipelineJob.Package, 1),
        error: null,
      });

      ctx.publish({
        type: PipelineEvent.AssetPlayable,
        aggregateType: 'Asset',
        aggregateId: asset.id,
        payload: {
          assetId: asset.id,
          ownerId: asset.ownerId,
          durationSeconds: asset.durationSeconds ?? 0,
          masterKey: masterPlaylistKey(asset.id),
          rungs: payload.rungs,
        },
      });
    });

    this.logger.log(`asset ${asset.id} is playable: ${payload.rungs.length} rung(s)`);
  }

  /**
   * The master playlist, built by hand rather than by ffmpeg.
   *
   * ffmpeg's own `-f hls -master_pl_name` writes a master only as a side effect of encoding
   * every rung in one process — which is exactly the fan-out this pipeline exists to avoid.
   * The format is six lines of text and the numbers are already known, so generating it
   * here keeps the rungs independent.
   *
   * `BANDWIDTH` is the sum of video and audio, which is what the spec means by it: a player
   * compares it against measured throughput to pick a rung, and quoting video-only makes it
   * choose a rung it cannot actually sustain.
   */
  private buildMaster(
    assetId: string,
    rungs: readonly string[],
    renditions: readonly { name: string; width: number | null; height: number | null }[],
  ): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    for (const rung of rungs) {
      const profile = profileFor(rung);
      if (!profile) continue;
      const bandwidth = profile.videoBitrateBps + profile.audioBitrateBps;

      // Dimensions come from the rendition row, which recorded what was actually encoded.
      // Deriving them from the profile would assume 16:9 and mis-declare every portrait
      // screen recording — and a player uses RESOLUTION to avoid picking a rung larger
      // than the viewport, so a wrong value costs the learner bandwidth.
      const row = renditions.find((r) => r.name === rung);
      const resolution = row?.width && row.height ? `${row.width}x${row.height}` : null;

      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}` +
          (resolution ? `,RESOLUTION=${resolution}` : '') +
          `,CODECS="avc1.4d401f,mp4a.40.2"`,
      );
      // Relative, so the playlist is portable: the same object works behind MinIO in dev
      // and a CloudFront distribution in production without being rewritten.
      lines.push(variantPlaylistKey(assetId, rung).split('/').slice(-2).join('/'));
    }

    return lines.join('\n') + '\n';
  }
}
