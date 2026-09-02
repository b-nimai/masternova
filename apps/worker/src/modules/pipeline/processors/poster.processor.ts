import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { PipelineJob, type PosterJobPayload } from '@masternova/contracts';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import { JobProcessor } from '../../../common/decorators/job-processor.decorator';
import { BaseJobProcessor, UnrecoverableJobError } from '../jobs/base-job.processor';
import { MEDIA_TOOLS, type IMediaTools } from '../ffmpeg/ffmpeg.interface';
import {
  PIPELINE_REPOSITORY,
  type IPipelineRepository,
} from '../repositories/pipeline.repository.interface';
import { POSTER_RENDITION, posterKey, sourceKey } from '../output-keys';

/** Wide enough for a course card at 2x, small enough to stay well under 100 KB as JPEG. */
const POSTER_WIDTH = 1280;

/**
 * Stage 2b — one still frame, used as the course card image and the player's poster.
 *
 * A sibling of the ladder rather than a step after it: it reads the *source*, so it does
 * not depend on any rung and there is no reason to make it wait for one.
 */
@JobProcessor(PipelineJob.Poster)
export class PosterProcessor extends BaseJobProcessor<PosterJobPayload> {
  readonly jobType = PipelineJob.Poster;
  protected readonly schema = z.object({
    assetId: z.string().min(1),
    atSeconds: z.number().nonnegative(),
  });

  constructor(
    @Inject(PIPELINE_REPOSITORY) private readonly repo: IPipelineRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(MEDIA_TOOLS) private readonly tools: IMediaTools,
  ) {
    super();
  }

  protected async isAlreadyDone(payload: PosterJobPayload): Promise<boolean> {
    return (await this.repo.findRendition(payload.assetId, POSTER_RENDITION)) !== null;
  }

  protected async execute(payload: PosterJobPayload): Promise<void> {
    const asset = await this.repo.findAsset(payload.assetId);
    if (!asset) throw new UnrecoverableJobError(`asset ${payload.assetId} does not exist`);

    const url = await this.storage.presignDownload(sourceKey(asset.id));
    const workDir = await mkdtemp(join(tmpdir(), `mn-poster-${asset.id}-`));

    try {
      const out = join(workDir, 'poster.jpg');
      await this.tools.run([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        // Before `-i`: seeking on the *input* lets ffmpeg jump straight to the keyframe
        // rather than decoding every frame up to that point. On a 90-minute lecture that
        // is the difference between a second and several minutes.
        '-ss',
        String(payload.atSeconds),
        '-i',
        url,
        '-frames:v',
        '1',
        // `-2` keeps the aspect ratio and rounds to an even height, which JPEG's 4:2:0
        // chroma subsampling requires just as H.264 does.
        '-vf',
        `scale=${POSTER_WIDTH}:-2`,
        '-q:v',
        '3',
        out,
      ]);

      const body = await readFile(out);
      await this.storage.putObject(posterKey(asset.id), body, 'image/jpeg');

      await this.repo.upsertRendition({
        assetId: asset.id,
        kind: 'POSTER',
        name: POSTER_RENDITION,
        storageKey: posterKey(asset.id),
        sizeBytes: BigInt(body.byteLength),
        width: POSTER_WIDTH,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
