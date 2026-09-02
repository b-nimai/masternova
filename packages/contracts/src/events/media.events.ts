/**
 * Events published by the `media` context.
 *
 * There is exactly one that matters today — an asset finished uploading — and it is the
 * seam the whole video pipeline hangs off. Task 1.7's probe/transcode DAG starts when it
 * sees `media.asset.ready`, which is why completing an upload does *not* call a transcode
 * service: media has no idea anyone is listening, and adding captions (1.16) or a search
 * index (1.13) later adds a handler, not a line in this module.
 */

export const MediaEvent = {
  /** The bytes are in object storage and the provider confirmed the assembled object. */
  AssetReady: 'media.asset.ready',
  /** The transfer ended without producing an object. Emitted by the reaper and by abort. */
  AssetFailed: 'media.asset.failed',
} as const;

export type MediaEventType = (typeof MediaEvent)[keyof typeof MediaEvent];

/**
 * Self-contained, like every payload here: a consumer must never have to query media's
 * tables to act on this. The pipeline needs the key and the type to fetch and probe, and
 * the owner to address the "transcode failed" email back to a human.
 */
export interface AssetReadyPayload {
  readonly assetId: string;
  readonly ownerId: string;
  readonly kind: 'VIDEO' | 'IMAGE' | 'ATTACHMENT';
  readonly storageKey: string;
  readonly contentType: string;
  /** A string, not a number: a 4 GB file exceeds nothing in JS, but JSON round-trips
   *  through the outbox and a BigInt has no JSON representation. */
  readonly sizeBytes: string;
  readonly originalFilename: string;
}

export interface AssetFailedPayload {
  readonly assetId: string;
  readonly ownerId: string;
  readonly kind: 'VIDEO' | 'IMAGE' | 'ATTACHMENT';
  /** `expired` or `aborted`. Enough for the instructor-facing email to say what happened. */
  readonly reason: string;
}
