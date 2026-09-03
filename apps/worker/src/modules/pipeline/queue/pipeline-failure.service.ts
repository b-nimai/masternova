import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PipelineEvent,
  UNIT_OF_WORK,
  type PipelineJobType,
  type UnitOfWork,
} from '@masternova/contracts';
import {
  PIPELINE_REPOSITORY,
  type IPipelineRepository,
} from '../repositories/pipeline.repository.interface';

/** Postgres `pipelineError` is a plain text column; a full ffmpeg stderr dump does not belong in it. */
const MAX_REASON_CHARS = 500;

/**
 * Moves an asset to `FAILED` when its pipeline gives up.
 *
 * Without this the asset stays `RUNNING` forever, and three things break at once: the
 * wizard's progress bar sticks at N% with no error, the SSE stream never reaches a terminal
 * state and polls until the client goes away, and `ReconciliationService.sweep` — which only
 * looks at assets in `READY` or `FAILED` — never sweeps the half-written rungs the abandoned
 * attempt left behind. That last one is the exact case the sweeper exists for.
 *
 * It is deliberately a separate collaborator rather than a branch inside `PipelineWorker`:
 * the worker's job is to drain a queue, and it should not grow a repository and a Unit of
 * Work to do it.
 */
@Injectable()
export class PipelineFailureService {
  private readonly logger = new Logger(PipelineFailureService.name);

  constructor(
    @Inject(PIPELINE_REPOSITORY) private readonly repo: IPipelineRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  /**
   * The state change and the event commit together, for the same reason packaging does it:
   * an asset marked FAILED with no `media.asset.processing_failed` in the outbox is a
   * failure no instructor is ever told about.
   *
   * Failing to *record* a failure must not itself throw — the caller is already in a catch
   * block and is about to rethrow the real error, which is the one worth surfacing.
   */
  async markFailed(jobType: PipelineJobType, data: unknown, error: Error): Promise<void> {
    const assetId = assetIdOf(data);
    if (!assetId) {
      this.logger.error(`cannot mark failed: job payload for ${jobType} carries no assetId`);
      return;
    }

    const reason = error.message.slice(0, MAX_REASON_CHARS);

    try {
      const asset = await this.repo.findAsset(assetId);
      if (!asset) {
        this.logger.warn(`cannot mark failed: asset ${assetId} no longer exists`);
        return;
      }

      await this.uow.execute(async (ctx) => {
        // Stage and percent are left as they were: "it died during transcode, at 45%" is
        // more useful to whoever reads the row than a reset to zero.
        await this.repo.setPipeline(assetId, 'FAILED', { error: reason }, ctx.executor);

        ctx.publish({
          type: PipelineEvent.AssetProcessingFailed,
          aggregateType: 'Asset',
          aggregateId: assetId,
          payload: { assetId, ownerId: asset.ownerId, jobType, reason },
        });
      });

      this.logger.error(`asset ${assetId} FAILED at ${jobType}: ${reason}`);
    } catch (recordingError) {
      this.logger.error(
        `could not record the failure of ${jobType} for asset ${assetId}: ${(recordingError as Error).message}`,
      );
    }
  }
}

/** Every pipeline payload carries `assetId`; this reads it without trusting the shape. */
function assetIdOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>).assetId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
