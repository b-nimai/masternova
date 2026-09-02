/**
 * Events published by the transcode pipeline.
 *
 * `media` (task 1.6) raises `media.asset.ready` when the *bytes* arrive; these say what
 * happened to them afterwards. Kept as separate events rather than a status field on one,
 * because the consumers differ: catalog cares that a lecture became playable, notification
 * cares that an instructor needs an email, and neither should learn the other exists.
 */

export const PipelineEvent = {
  /** Every rendition exists and the HLS master is written. The lecture is playable. */
  AssetPlayable: 'media.asset.playable',
  /** The pipeline exhausted its retries. The job is in the dead-letter set. */
  AssetProcessingFailed: 'media.asset.processing_failed',
} as const;

export type PipelineEventType = (typeof PipelineEvent)[keyof typeof PipelineEvent];

export interface AssetPlayablePayload {
  readonly assetId: string;
  readonly ownerId: string;
  readonly durationSeconds: number;
  /** The HLS master playlist key. What the player is eventually pointed at. */
  readonly masterKey: string;
  readonly rungs: readonly string[];
}

export interface AssetProcessingFailedPayload {
  readonly assetId: string;
  readonly ownerId: string;
  /** The job type that gave up, so the instructor email can say which step. */
  readonly jobType: string;
  readonly reason: string;
}
