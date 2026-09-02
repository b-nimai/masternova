/**
 * The job vocabulary of the transcode pipeline.
 *
 * It lives in `contracts` rather than inside the worker because the **API** needs it too:
 * the DLQ replay endpoint (task 1.7) names a job type, and the SSE progress stream reports
 * a stage. Neither should import the worker's internals — that is the cross-app boundary
 * `packages/db` and `packages/storage` already exist to prevent.
 */

export const PipelineJob = {
  /** Read the source with ffprobe: duration, resolution, codecs. Decides the ladder. */
  Probe: 'media.probe',
  /** One rung of the ABR ladder → an HLS variant playlist plus its segments. */
  Transcode: 'media.transcode',
  /** Write the HLS master playlist. Runs only after every rung has landed. */
  Package: 'media.package',
  /** A single still frame for the course card and the player's poster. */
  Poster: 'media.poster',
  /** The scrubbing filmstrip: a thumbnail grid plus its WebVTT index. */
  Sprite: 'media.sprite',
} as const;

export type PipelineJobType = (typeof PipelineJob)[keyof typeof PipelineJob];

/**
 * Every payload carries `assetId` and nothing derivable from it.
 *
 * A job payload is a message that may sit in Redis for hours and be replayed days later, so
 * it must not carry a snapshot of mutable state — the storage key and the owner are read
 * from the row at execution time. What it *does* carry is the decision the previous stage
 * made, because that decision is not reproducible: re-probing a source to rediscover the
 * ladder would let a replay silently transcode a different set of rungs than its siblings.
 */
export interface ProbeJobPayload {
  readonly assetId: string;
}

export interface TranscodeJobPayload {
  readonly assetId: string;
  /** The ladder rung, e.g. `720p`. Half of the deterministic output key. */
  readonly rung: string;
}

export interface PackageJobPayload {
  readonly assetId: string;
  /** The rungs this master must list. Fixed by probe so a replay cannot disagree. */
  readonly rungs: readonly string[];
}

export interface PosterJobPayload {
  readonly assetId: string;
  /** Where to grab the frame, in seconds. Derived from the probed duration. */
  readonly atSeconds: number;
}

export interface SpriteJobPayload {
  readonly assetId: string;
  readonly durationSeconds: number;
}

export type PipelineJobPayload =
  ProbeJobPayload | TranscodeJobPayload | PackageJobPayload | PosterJobPayload | SpriteJobPayload;
