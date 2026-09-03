import { PipelineJob, type PipelineJobType } from '@masternova/contracts';

/**
 * Deterministic BullMQ job ids — the queue-level half of this pipeline's idempotency.
 *
 * The outbox relay delivers at-least-once, so `media.asset.ready` can arrive twice. BullMQ
 * refuses to add a second job with an id already present, which turns that duplicate into a
 * no-op before any work is enqueued. This is the `jobId` dedupe idea recorded against this
 * task in `BUILD_PLAN.md` §2.2 when Loom's queue module was dropped.
 *
 * **The separator is `_`, and that is not cosmetic.** BullMQ reserves `:` for its own Redis
 * key structure and rejects a custom id containing one — with `Custom Id cannot contain :`,
 * thrown at enqueue time. The first version of this used `probe:${assetId}` and every
 * fan-out failed; the integration test caught it, not review.
 */
const SEPARATOR = '_';

/** Rejected by BullMQ, so a name reaching one of these must never contain it. */
export const FORBIDDEN_IN_JOB_ID = ':';

export function probeJobId(assetId: string): string {
  return join(PipelineJob.Probe, assetId);
}

export function transcodeJobId(assetId: string, rung: string): string {
  return join(PipelineJob.Transcode, assetId, rung);
}

export function packageJobId(assetId: string): string {
  return join(PipelineJob.Package, assetId);
}

export function posterJobId(assetId: string): string {
  return join(PipelineJob.Poster, assetId);
}

export function spriteJobId(assetId: string): string {
  return join(PipelineJob.Sprite, assetId);
}

/**
 * The job *type* is part of the id, so the five jobs for one asset cannot collide — and
 * the dots in `media.probe` are replaced for the same reason the colons are: an id is a
 * Redis key fragment, and only a bounded alphabet is safe there.
 */
function join(type: PipelineJobType, ...parts: string[]): string {
  return [type.replace(/\./g, SEPARATOR), ...parts].join(SEPARATOR);
}
