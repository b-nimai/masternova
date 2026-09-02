import { Inject, Injectable, Logger } from '@nestjs/common';
import { MediaEvent, UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import type { AssetView } from '@masternova/shared';
import {
  AssetNotFoundException,
  IllegalUploadTransitionException,
  UploadInProgressException,
  UploadSizeMismatchException,
  MalformedUploadPartException,
  UploadIncompleteException,
  UploadSessionExpiredException,
  UploadSessionNotFoundException,
} from '../../common/exceptions';
import { STORAGE_PROVIDER, type IStorageProvider, type StoredPart } from '@masternova/storage';
import type { Actor } from '../catalog/actor';
import { MIN_PART_SIZE, partRange } from './upload-plan';
import { isTerminal, transitionOn } from './upload-session';
import { toAssetView } from './asset.service';
import { UploadSessionService } from './upload-session.service';
import {
  MEDIA_REPOSITORY,
  type IMediaRepository,
  type UploadSessionWithAsset,
} from './repositories/media.repository.interface';

/**
 * Ending an upload — the successful way and the two unsuccessful ways.
 *
 * Split from `UploadSessionService` because they change for different reasons: that one
 * owns the part plan and the resume window, this one owns the provider's assemble step and
 * the event that starts the transcode pipeline. Together they would be nine public methods
 * and well past the ~200-line limit CLAUDE.md §3 sets.
 */
/**
 * How long an assemble is presumed to still be running.
 *
 * A COMPLETING session younger than this belongs to a request that is very likely still
 * inside `completeMultipartUpload`, and touching it would steal a claim that is doing its
 * job. Older than this and the process that claimed it is gone — nothing else takes this
 * long, because the parts are already in the bucket and the provider is only stitching
 * metadata. Two minutes is generous for that and still well inside the session TTL.
 */
const ASSEMBLE_GRACE_MS = 2 * 60_000;

@Injectable()
export class UploadCompletionService {
  private readonly logger = new Logger(UploadCompletionService.name);

  constructor(
    private readonly sessions: UploadSessionService,
    @Inject(MEDIA_REPOSITORY) private readonly media: IMediaRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  /**
   * Assemble the parts into one object and hand the asset to the pipeline.
   *
   * **The ordering, which is the whole design: claim, then call the provider.**
   * `CompleteMultipartUpload` is not idempotent — the second caller gets `NoSuchUpload`,
   * not a second success. So if ten retries all reached the provider, one would succeed and
   * nine would raise a 500 for an upload that had in fact worked. Moving the session to
   * COMPLETING first makes the conditional transition the mutex: exactly one caller ever
   * reaches the assemble, and the other nine get a 409 that accurately says "someone else
   * is finishing this".
   *
   * **What happens if we die mid-assemble.** The session is left in COMPLETING, and the
   * next call cannot learn anything by retrying the assemble — the provider's answer is
   * the same whether it already succeeded or never started. So recovery asks a different
   * question: does the object exist? That is `recover()` below, and it is why
   * `objectExists` is on the storage port.
   */
  async complete(sessionId: string, actor: Actor): Promise<AssetView> {
    const session = await this.sessions.load(sessionId, actor);

    if (session.status === 'COMPLETING') {
      // Someone else claimed it and is very likely still inside the provider call. Report
      // the conflict and change nothing — releasing it here would steal a live claim, and
      // the request doing the real work would then fail to finish its own upload.
      if (Date.now() - session.updatedAt.getTime() < ASSEMBLE_GRACE_MS) {
        throw new UploadInProgressException();
      }
      // Old enough that the process which claimed it is gone. Now recovery is safe.
      return this.recover(session);
    }

    if (!transitionOn(session.status, 'complete')) {
      throw new IllegalUploadTransitionException(session.status, 'complet');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      // The provider may already have reclaimed the parts; assembling now would either
      // fail obscurely or produce a truncated object.
      throw new UploadSessionExpiredException();
    }

    // Validated before the claim: a client whose parts are missing should be told so and
    // left free to send them, not parked in COMPLETING with nothing to assemble.
    const stored = await this.storage.listParts(session.asset.storageKey, session.uploadId);
    this.assertComplete(session, stored);

    const claimed = await this.media.transition(session.id, 'COMPLETING', session.status, {});
    if (!claimed) {
      // Lost the race. Someone else is assembling, or already did.
      throw new IllegalUploadTransitionException(session.status, 'complet');
    }

    try {
      await this.storage.completeMultipartUpload(
        session.asset.storageKey,
        session.uploadId,
        stored.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      );
    } catch (error) {
      // The provider threw — but that does not mean it did not commit. A response timeout
      // or a dropped socket after S3 assembled the object looks identical to a failure,
      // and releasing the session then would strand a real object with no asset pointing
      // at it. Ask the question the error cannot answer.
      if (await this.storage.objectExists(session.asset.storageKey)) {
        this.logger.warn(`upload ${session.id} assemble errored but the object exists`);
        return this.finish(session);
      }
      // Genuinely not assembled. Hand the session back so the client can retry, rather
      // than stranding it in a state with no exit.
      await this.media.transition(session.id, 'UPLOADING', 'COMPLETING', {});
      throw error;
    }

    return this.finish(session);
  }

  /**
   * A session found in COMPLETING: decide what actually happened, and finish the job.
   *
   * The object either exists — in which case a previous attempt assembled it and only the
   * bookkeeping is missing — or it does not, in which case the assemble never landed and
   * the session goes back to UPLOADING for the client to retry. Both outcomes are derived
   * from the provider, not assumed.
   */
  async recover(session: UploadSessionWithAsset): Promise<AssetView> {
    if (await this.storage.objectExists(session.asset.storageKey)) {
      this.logger.warn(`upload ${session.id} recovered: object exists, finishing bookkeeping`);
      return this.finish(session);
    }

    await this.media.transition(session.id, 'UPLOADING', 'COMPLETING', {});
    throw new IllegalUploadTransitionException('COMPLETING', 'complet');
  }

  /**
   * The bookkeeping half, run only once the object is known to exist.
   *
   * The state change, the asset flip and the event commit together — an asset marked READY
   * with no `asset.ready` in the outbox is a lecture that never gets transcoded, and it
   * would be invisible until a learner pressed play.
   */
  private finish(session: UploadSessionWithAsset): Promise<AssetView> {
    return this.uow.execute(async (ctx) => {
      // Re-read inside the transaction rather than assuming the session is still
      // COMPLETING. It may not be: a concurrent retry whose grace period elapsed can have
      // released this very claim back to UPLOADING while the assemble was still running.
      // Insisting on COMPLETING here would 409 a request whose object is in the bucket,
      // leaving the asset PENDING forever and the event unraised.
      const current = await this.media.findSession(session.id, ctx.executor);
      if (!current) throw new UploadSessionNotFoundException();

      if (current.status === 'COMPLETED') {
        // Someone else already did the work and raised the event. Returning their result
        // is the correct answer to a retry; raising a second event would double-transcode.
        const existing = await this.media.findAsset(session.assetId, ctx.executor);
        if (!existing) throw new AssetNotFoundException();
        return toAssetView(existing);
      }

      if (isTerminal(current.status)) {
        // ABORTED or EXPIRED. The object exists, but someone deliberately ended this
        // upload — resurrecting it here would undo an instructor's cancel.
        throw new IllegalUploadTransitionException(current.status, 'complet');
      }

      const moved = await this.media.transition(
        session.id,
        'COMPLETED',
        current.status,
        { completedAt: new Date() },
        ctx.executor,
      );
      // Another caller finished it between our read and this write. It did the work and
      // raised the event; this call must not raise a second one.
      if (!moved) throw new IllegalUploadTransitionException(current.status, 'complet');

      const asset = await this.media.setAssetStatus(
        session.assetId,
        'READY',
        { readyAt: new Date() },
        ctx.executor,
      );

      ctx.publish({
        type: MediaEvent.AssetReady,
        aggregateType: 'Asset',
        aggregateId: asset.id,
        payload: {
          assetId: asset.id,
          ownerId: asset.ownerId,
          kind: asset.kind,
          storageKey: asset.storageKey,
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes.toString(),
          originalFilename: asset.originalFilename,
        },
      });

      this.logger.log(`upload ${session.id} completed: asset ${asset.id} is READY`);
      return toAssetView(asset);
    });
  }

  /** The instructor pressed cancel. Same shape as the reaper's expire, different reason. */
  async abort(sessionId: string, actor: Actor): Promise<void> {
    const session = await this.sessions.load(sessionId, actor);
    if (!transitionOn(session.status, 'abort')) {
      throw new IllegalUploadTransitionException(session.status, 'abort');
    }
    await this.end(session, 'ABORTED', 'aborted');
  }

  /**
   * The one path that both cancel and expiry take: **claim the row, then abort the parts.**
   *
   * The order is the whole design. Aborting first looks natural — stop paying for the
   * bytes, then tidy the row — and it is wrong twice over. The reaper runs in every API
   * replica, so two of them would both call abort and the second would get `NoSuchUpload`;
   * worse, an abort issued while a browser is inside `completeMultipartUpload` destroys the
   * parts of an upload that is about to succeed, and the instructor's file disappears
   * halfway through being saved.
   *
   * Claiming first makes the conditional transition the mutex: exactly one caller ever
   * reaches the abort, and it only reaches it after establishing that nobody completed the
   * session. The residual risk is the opposite one — the row says EXPIRED and the parts
   * survive — which costs storage, is invisible to correctness, and is swept by the
   * bucket's own multipart lifecycle rule (`infra/`).
   */
  async end(
    session: UploadSessionWithAsset,
    to: 'ABORTED' | 'EXPIRED',
    reason: string,
  ): Promise<boolean> {
    const claimed = await this.uow.execute(async (ctx) => {
      const moved = await this.media.transition(
        session.id,
        to,
        session.status,
        { endedReason: reason },
        ctx.executor,
      );
      // Someone completed it, or another replica claimed it first. Either way this call
      // changed nothing and must not mark a live lecture's media FAILED.
      if (!moved) return false;

      const asset = await this.media.setAssetStatus(session.assetId, 'FAILED', {}, ctx.executor);

      ctx.publish({
        type: MediaEvent.AssetFailed,
        aggregateType: 'Asset',
        aggregateId: asset.id,
        payload: {
          assetId: asset.id,
          ownerId: asset.ownerId,
          kind: asset.kind,
          reason,
        },
      });

      return true;
    });

    if (!claimed) return false;

    // Outside the transaction on purpose: a provider call inside one holds a database
    // connection open for the length of a network round trip, and failing it here must not
    // roll back a claim that is already correct.
    try {
      await this.storage.abortMultipartUpload(session.asset.storageKey, session.uploadId);
    } catch (error) {
      this.logger.warn(
        `upload ${session.id} claimed as ${to} but its parts were not reclaimed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    return true;
  }

  /**
   * Checked here rather than left to the provider, because S3 answers both of these with
   * one opaque `EntityTooSmall` or `InvalidPart` at complete time — after the instructor
   * has waited out the entire transfer, and without saying which part is at fault.
   */
  private assertComplete(session: UploadSessionWithAsset, stored: StoredPart[]): void {
    const have = new Set(stored.map((part) => part.partNumber));
    const missing: number[] = [];
    for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
      if (!have.has(partNumber)) missing.push(partNumber);
    }
    if (missing.length > 0) {
      throw new UploadIncompleteException(missing, session.partCount);
    }

    const plan = { partSize: session.partSize, partCount: session.partCount };

    for (const part of stored) {
      // Every part but the last must clear the provider's floor. A short middle part means
      // the client sliced the file with boundaries other than the ones it was given.
      if (part.partNumber !== session.partCount && part.sizeBytes < MIN_PART_SIZE) {
        throw new MalformedUploadPartException(part.partNumber);
      }

      // And every part must be exactly the size the plan assigned it.
      //
      // Without this the declared `sizeBytes` is unenforceable: a presigned `UploadPart`
      // URL binds no content length, so a client could declare one byte as an IMAGE — a
      // single part, which is the last part and therefore skips the floor check above —
      // then PUT 5 GB to it. The size cap would be bypassed and `media.asset.ready` would
      // announce a 1-byte asset to a transcode pipeline about to open a 5 GB file.
      const range = partRange(plan, session.asset.sizeBytes, part.partNumber);
      const expected = Number(range.end - range.start);
      if (part.sizeBytes !== expected) {
        throw new MalformedUploadPartException(part.partNumber);
      }
    }

    // Belt and braces on the total, so a future change to the per-part check cannot
    // silently reopen the hole. Cheap: the sizes are already in hand.
    const total = stored.reduce((sum, part) => sum + BigInt(part.sizeBytes), 0n);
    if (total !== session.asset.sizeBytes) {
      throw new UploadSizeMismatchException(session.asset.sizeBytes, total);
    }
  }
}
