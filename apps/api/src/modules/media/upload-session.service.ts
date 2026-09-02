import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AssetKind } from '@masternova/db';
import type { CreateUploadInput, UploadPartTarget, UploadSessionView } from '@masternova/shared';
import {
  UnsupportedMediaKindException,
  UploadSessionExpiredException,
  UploadSessionNotFoundException,
  UploadTooLargeException,
} from '../../common/exceptions';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import type { Actor } from '../catalog/actor';
import { policyFor, storageKeyFor } from './media-policy';
import { partRange, planUpload, type UploadPlan } from './upload-plan';
import { isTerminal, transitionOn } from './upload-session';
import {
  MEDIA_REPOSITORY,
  type IMediaRepository,
  type UploadSessionWithAsset,
} from './repositories/media.repository.interface';

/**
 * How long a client has to finish. Long enough for a 10 GB upload on a bad connection to
 * survive an overnight pause; short enough that abandoned multipart uploads — which are
 * billed storage nobody can see in a bucket listing — are reclaimed the same day.
 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long each presigned part URL is good for. Deliberately much shorter than the
 * session: a URL is a bearer credential to write into our bucket, and the resume endpoint
 * re-issues them for free, so there is no reason to hand out a 24-hour one.
 */
const PART_URL_TTL_SECONDS = 60 * 60;

/**
 * How many part URLs one response carries.
 *
 * Signing is local HMAC, so the cost is not the signing — it is the response. A 10 GB
 * upload is 1250 parts, and 1250 presigned URLs is roughly a megabyte of JSON handed to a
 * client that can only upload a handful at a time anyway. Worse, the last of those URLs
 * would expire long before a slow connection reached it.
 *
 * So the client gets a window: send these, ask again, get the next window. That is the
 * same call it already makes to resume, which means there is no second code path — the
 * recovery path *is* the normal path, and is therefore exercised on every upload rather
 * than only after a crash.
 */
const PART_URL_BATCH = 100;

/**
 * Starting an upload, and picking it back up after the network died.
 *
 * **The problem this module exists to solve.** A 10 GB lecture over hotel wifi will not
 * survive one request. Multipart splits it, but the interesting question is not "how do we
 * split it" — it is "after the browser was killed at part 340 of 1250, how does it find
 * out that 339 landed?" This service's answer is that it never guesses: it asks the
 * provider, because the parts went straight from the browser to object storage and the API
 * was never in that path.
 */
@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);

  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: IMediaRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {}

  /**
   * The provider's multipart upload is created *before* the row, on purpose.
   *
   * The other order leaves a session row whose `uploadId` is a lie if the provider call
   * then fails — a session that can never be resumed and never be completed, which the
   * reaper would have to special-case. This order can leak a multipart upload the database
   * never learned about, which is a cost problem the bucket's own lifecycle rule already
   * sweeps, and never a correctness one.
   */
  async create(input: CreateUploadInput, actor: Actor): Promise<UploadSessionView> {
    const kind = input.kind as AssetKind;
    const policy = policyFor(kind);

    if (!policy.contentTypes.includes(input.contentType)) {
      throw new UnsupportedMediaKindException(kind, input.contentType, policy.contentTypes);
    }

    const sizeBytes = BigInt(input.sizeBytes);
    if (sizeBytes > policy.maxBytes) {
      throw new UploadTooLargeException(sizeBytes, policy.maxBytes);
    }

    const plan = planUpload(sizeBytes);

    // The key must be known before the provider call, and the asset id is what makes it
    // deterministic — so the id is minted here rather than by the database default.
    const assetId = randomUUID();
    const storageKey = storageKeyFor(kind, assetId);
    const uploadId = await this.storage.createMultipartUpload(storageKey, input.contentType);

    const session = await this.media.createUpload({
      assetId,
      ownerId: actor.id,
      kind,
      contentType: input.contentType,
      sizeBytes,
      originalFilename: input.filename,
      storageKey,
      uploadId,
      partSize: plan.partSize,
      partCount: plan.partCount,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    this.logger.log(
      `upload ${session.id} created: ${plan.partCount} × ${plan.partSize}B for ${input.filename}`,
    );

    return this.view(session, []);
  }

  /**
   * Resume. Also the progress endpoint, because they are the same question.
   *
   * Returns fresh URLs for exactly the parts the provider is *not* holding. A client that
   * knows only its session id can drive the whole recovery from this one response, which is
   * the property that makes the upload survive a browser crash rather than merely a flaky
   * connection.
   */
  async resume(sessionId: string, actor: Actor): Promise<UploadSessionView> {
    const session = await this.load(sessionId, actor);

    if (isTerminal(session.status)) {
      // Nothing left to send, and re-signing URLs for a finished upload would hand out
      // write credentials against an object that is already someone's lecture.
      return this.view(session, [], { signMissing: false });
    }

    if (session.status === 'COMPLETING') {
      // Status only. The provider may already have consumed the multipart upload, in which
      // case `listParts` answers `NoSuchUpload` — so polling a session that is being
      // finalised would return 500s instead of telling the client to wait. That window is
      // unbounded for a session stranded by a crashed process.
      return this.view(session, [], { signMissing: false });
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UploadSessionExpiredException();
    }

    const stored = await this.storage.listParts(session.asset.storageKey, session.uploadId);

    // Record the first observed byte, so the reaper can tell a stalled transfer from one
    // that never started. Conditional on the state we read: losing this race to an abort
    // is fine and must not resurrect the session, which is why the result is not checked.
    if (stored.length > 0 && session.status === 'CREATED' && transitionOn('CREATED', 'observe')) {
      await this.media.transition(session.id, 'UPLOADING', 'CREATED', {});
      session.status = 'UPLOADING';
    }

    return this.view(
      session,
      stored.map((part) => part.partNumber),
    );
  }

  /** The ownership check every session route makes. Kept here so it reads once, not four times. */
  async load(sessionId: string, actor: Actor): Promise<UploadSessionWithAsset> {
    const session = await this.media.findSession(sessionId);
    if (!session || (session.ownerId !== actor.id && actor.role !== 'ADMIN')) {
      throw new UploadSessionNotFoundException();
    }
    return session;
  }

  private async view(
    session: UploadSessionWithAsset,
    uploadedParts: number[],
    options: { signMissing?: boolean } = {},
  ): Promise<UploadSessionView> {
    const plan: UploadPlan = { partSize: session.partSize, partCount: session.partCount };
    const have = new Set(uploadedParts);

    const missing: number[] = [];
    for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) {
      if (!have.has(partNumber)) missing.push(partNumber);
    }

    const window = options.signMissing === false ? [] : missing.slice(0, PART_URL_BATCH);

    const parts: UploadPartTarget[] = await Promise.all(
      window.map(async (partNumber) => {
        const range = partRange(plan, session.asset.sizeBytes, partNumber);
        return {
          partNumber,
          url: await this.storage.presignUploadPart(
            session.asset.storageKey,
            session.uploadId,
            partNumber,
            PART_URL_TTL_SECONDS,
          ),
          rangeStart: range.start.toString(),
          rangeEnd: range.end.toString(),
        };
      }),
    );

    return {
      sessionId: session.id,
      assetId: session.assetId,
      status: session.status,
      partSize: session.partSize,
      partCount: session.partCount,
      uploadedParts: [...have].sort((a, b) => a - b),
      parts,
      expiresAt: session.expiresAt.toISOString(),
    };
  }
}
