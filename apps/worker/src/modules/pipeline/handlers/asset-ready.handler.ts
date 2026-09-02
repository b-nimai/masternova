import { Logger } from '@nestjs/common';
import {
  MediaEvent,
  type AssetReadyPayload,
  type DomainEvent,
  type DomainEventHandler,
} from '@masternova/contracts';
import { EventHandler } from '../../../common/decorators/event-handler.decorator';
import { JobQueueService } from '../queue/job-queue.service';

/**
 * Starts the pipeline when an upload finishes.
 *
 * This is the seam task 1.6 was built against: `media` publishes `media.asset.ready` and
 * stops. It does not call a transcode service, does not know this handler exists, and did
 * not change when the pipeline was added — which is the entire point of the outbox.
 *
 * Non-video assets are ignored rather than rejected. A course thumbnail is a perfectly good
 * asset that simply has no pipeline, and treating "nothing to do" as a failure would fill
 * the dead-letter set with images.
 */
@EventHandler()
export class AssetReadyHandler implements DomainEventHandler<AssetReadyPayload> {
  /** Stable, and it is the dedupe key in `ProcessedEvent` — renaming it replays history. */
  readonly name = 'pipeline.start-on-asset-ready';
  readonly eventType = MediaEvent.AssetReady;

  private readonly logger = new Logger(AssetReadyHandler.name);

  constructor(private readonly queue: JobQueueService) {}

  async handle(event: DomainEvent<AssetReadyPayload>): Promise<void> {
    const { assetId, kind } = event.payload;

    if (kind !== 'VIDEO') {
      this.logger.debug(`asset ${assetId} is ${kind}; no pipeline to run`);
      return;
    }

    await this.queue.enqueueProbe(assetId);
  }
}
