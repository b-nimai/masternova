import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { PipelineJob, type SpriteJobPayload } from '@masternova/contracts';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import { JobProcessor } from '../../../common/decorators/job-processor.decorator';
import { BaseJobProcessor, UnrecoverableJobError } from '../jobs/base-job.processor';
import { MEDIA_TOOLS, type IMediaTools } from '../ffmpeg/ffmpeg.interface';
import {
  PIPELINE_REPOSITORY,
  type IPipelineRepository,
} from '../repositories/pipeline.repository.interface';
import { SPRITE_RENDITION, sourceKey, spriteImageKey, spriteVttKey } from '../output-keys';
import { SPRITE_TILE_HEIGHT, SPRITE_TILE_WIDTH, spriteLayout, spriteVtt } from '../sprite-sheet';

/**
 * Stage 2c — the scrubbing filmstrip: one tiled image plus the WebVTT that indexes it.
 *
 * One image rather than N thumbnails, because a player showing a preview on hover would
 * otherwise fire a request per position — hundreds of round trips during a single drag.
 * The sheet is fetched once and every thumbnail is a CSS crop of it.
 */
@JobProcessor(PipelineJob.Sprite)
export class SpriteProcessor extends BaseJobProcessor<SpriteJobPayload> {
  readonly jobType = PipelineJob.Sprite;
  protected readonly schema = z.object({
    assetId: z.string().min(1),
    durationSeconds: z.number().positive(),
  });

  constructor(
    @Inject(PIPELINE_REPOSITORY) private readonly repo: IPipelineRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(MEDIA_TOOLS) private readonly tools: IMediaTools,
  ) {
    super();
  }

  protected async isAlreadyDone(payload: SpriteJobPayload): Promise<boolean> {
    return (await this.repo.findRendition(payload.assetId, SPRITE_RENDITION)) !== null;
  }

  protected async execute(payload: SpriteJobPayload): Promise<void> {
    const asset = await this.repo.findAsset(payload.assetId);
    if (!asset) throw new UnrecoverableJobError(`asset ${payload.assetId} does not exist`);

    const layout = spriteLayout(payload.durationSeconds);
    const url = await this.storage.presignDownload(sourceKey(asset.id));
    const workDir = await mkdtemp(join(tmpdir(), `mn-sprite-${asset.id}-`));

    try {
      const out = join(workDir, 'sprite.jpg');
      await this.tools.run([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        url,
        // One frame per interval, scaled to a tile, tiled into a grid. `fps` here is a
        // rate, so `1/interval` means "one frame every `interval` seconds".
        '-vf',
        `fps=1/${layout.intervalSeconds},scale=${SPRITE_TILE_WIDTH}:${SPRITE_TILE_HEIGHT}:force_original_aspect_ratio=increase,crop=${SPRITE_TILE_WIDTH}:${SPRITE_TILE_HEIGHT},tile=${layout.columns}x${layout.rows}`,
        '-frames:v',
        '1',
        '-q:v',
        '5',
        out,
      ]);

      const image = await readFile(out);
      await this.storage.putObject(spriteImageKey(asset.id), image, 'image/jpeg');

      // A relative URL, so the VTT works behind MinIO in dev and a CDN in production
      // without being rewritten — the same reason the master playlist is relative.
      const vtt = Buffer.from(spriteVtt(layout, 'sprite.jpg'), 'utf8');
      await this.storage.putObject(spriteVttKey(asset.id), vtt, 'text/vtt');

      await this.repo.upsertRendition({
        assetId: asset.id,
        kind: 'SPRITE',
        name: SPRITE_RENDITION,
        storageKey: spriteImageKey(asset.id),
        sizeBytes: BigInt(image.byteLength + vtt.byteLength),
        width: SPRITE_TILE_WIDTH * layout.columns,
        height: SPRITE_TILE_HEIGHT * layout.rows,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
