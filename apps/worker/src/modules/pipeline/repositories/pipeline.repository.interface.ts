import type { Asset, MediaRendition, PipelineStatus, RenditionKind } from '@masternova/db';

export const PIPELINE_REPOSITORY = Symbol('PIPELINE_REPOSITORY');

export interface RenditionRecord {
  readonly assetId: string;
  readonly kind: RenditionKind;
  readonly name: string;
  readonly storageKey: string;
  readonly sizeBytes: bigint;
  readonly width?: number;
  readonly height?: number;
  readonly bitrateBps?: number;
}

export interface IPipelineRepository {
  findAsset(assetId: string): Promise<Asset | null>;

  /** Set by probe, and the only place duration is written. */
  recordProbe(assetId: string, durationSeconds: number): Promise<void>;

  /**
   * **Upsert on `(assetId, name)`, which is the idempotency mechanism.**
   *
   * A redelivered transcode writes the same deterministic key and lands on the same row.
   * Insert-only would accumulate a duplicate rendition per redelivery, and the master
   * playlist would then list the same rung four times.
   */
  upsertRendition(rendition: RenditionRecord): Promise<void>;

  findRendition(assetId: string, name: string): Promise<MediaRendition | null>;
  listRenditions(assetId: string): Promise<MediaRendition[]>;

  setPipeline(
    assetId: string,
    status: PipelineStatus,
    patch: { stage?: string; percent?: number; error?: string | null },
  ): Promise<void>;

  /**
   * Progress only ever moves forward.
   *
   * Rungs finish out of order and each reports its own fraction, so an unguarded write lets
   * a slow 240p overwrite a finished 1080p and the wizard's bar jumps backwards. A bar that
   * goes backwards reads as a broken upload, which is a support ticket.
   */
  advanceProgress(assetId: string, percent: number, stage: string): Promise<void>;
}
