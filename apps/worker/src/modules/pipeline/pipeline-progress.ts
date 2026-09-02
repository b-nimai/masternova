import { PipelineJob, type PipelineJobType } from '@masternova/contracts';

/**
 * How each stage maps onto the single 0–100 the wizard shows.
 *
 * **Why weights and not "one fifth per job".** The stages are wildly uneven: probing a
 * 90-minute lecture takes a second, transcoding it takes minutes per rung. Equal weights
 * would make the bar leap to 20% instantly and then sit still for ten minutes, which reads
 * as a hang. These weights are roughly proportional to wall-clock time, so the bar moves at
 * something like a constant rate.
 *
 * Pure and unit-tested: a progress bar that can go backwards or exceed 100 is a support
 * ticket, and both are cheap to assert here.
 */
const STAGE_WEIGHT: Record<PipelineJobType, number> = {
  [PipelineJob.Probe]: 5,
  [PipelineJob.Transcode]: 75,
  [PipelineJob.Poster]: 5,
  [PipelineJob.Sprite]: 10,
  [PipelineJob.Package]: 5,
};

/** Where each stage's band starts, in the order they complete. */
const STAGE_ORDER: PipelineJobType[] = [
  PipelineJob.Probe,
  PipelineJob.Transcode,
  PipelineJob.Poster,
  PipelineJob.Sprite,
  PipelineJob.Package,
];

function bandStart(type: PipelineJobType): number {
  let start = 0;
  for (const stage of STAGE_ORDER) {
    if (stage === type) break;
    start += STAGE_WEIGHT[stage];
  }
  return start;
}

/**
 * The overall percentage for a stage that is `fraction` complete.
 *
 * `rungIndex`/`rungCount` subdivide the transcode band, because the fan-out is the long
 * part and a bar that sits at 5% for four rungs and then jumps to 80% tells the instructor
 * nothing. Rungs finish out of order, so this reports *the rung's own slice* — and the
 * repository's forward-only guard is what stops a slow 240p overwriting a finished 1080p.
 */
export function overallPercent(
  type: PipelineJobType,
  fraction: number,
  rung?: { index: number; count: number },
): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  const start = bandStart(type);
  const width = STAGE_WEIGHT[type];

  if (type === PipelineJob.Transcode && rung && rung.count > 0) {
    const slice = width / rung.count;
    return Math.round(start + slice * (rung.index + clamped));
  }

  return Math.round(start + width * clamped);
}

/** Human-facing label for the wizard. Free text, deliberately — see the schema comment. */
export function stageLabel(type: PipelineJobType, rung?: string): string {
  switch (type) {
    case PipelineJob.Probe:
      return 'Inspecting the video';
    case PipelineJob.Transcode:
      return rung ? `Encoding ${rung}` : 'Encoding';
    case PipelineJob.Poster:
      return 'Creating the thumbnail';
    case PipelineJob.Sprite:
      return 'Building the scrub preview';
    case PipelineJob.Package:
      return 'Finalising';
  }
}

/** Asserted in tests: the bands must tile 0–100 exactly, or the bar never reaches the end. */
export const TOTAL_WEIGHT = STAGE_ORDER.reduce((sum, stage) => sum + STAGE_WEIGHT[stage], 0);
