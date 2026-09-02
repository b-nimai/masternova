import { PipelineJob } from '@masternova/contracts';
import { TOTAL_WEIGHT, overallPercent, stageLabel } from './pipeline-progress';

describe('pipeline progress', () => {
  /** If the bands do not tile 0-100, the bar never reaches the end and never starts at 0. */
  it('weights the stages to exactly 100', () => {
    expect(TOTAL_WEIGHT).toBe(100);
  });

  it('reaches 100 only when the last stage completes', () => {
    expect(overallPercent(PipelineJob.Package, 1)).toBe(100);
    expect(overallPercent(PipelineJob.Probe, 1)).toBeLessThan(100);
    expect(overallPercent(PipelineJob.Transcode, 1)).toBeLessThan(100);
  });

  it('never leaves the 0–100 range, whatever a tool reports', () => {
    // ffmpeg can report an out_time past the duration on a VFR source.
    for (const fraction of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      for (const stage of Object.values(PipelineJob)) {
        const percent = overallPercent(stage, fraction);
        if (Number.isNaN(fraction)) continue;
        expect(percent).toBeGreaterThanOrEqual(0);
        expect(percent).toBeLessThanOrEqual(100);
      }
    }
  });

  it('moves forward across the stages in the order they run', () => {
    const probe = overallPercent(PipelineJob.Probe, 1);
    const transcode = overallPercent(PipelineJob.Transcode, 1);
    const pack = overallPercent(PipelineJob.Package, 1);
    expect(probe).toBeLessThan(transcode);
    expect(transcode).toBeLessThan(pack);
  });

  /**
   * The fan-out is the long part. Without subdividing it the bar would sit at 5% for four
   * rungs and then jump to 80%, which reads as a hang.
   */
  it('subdivides the transcode band across the rungs', () => {
    const first = overallPercent(PipelineJob.Transcode, 1, { index: 0, count: 4 });
    const last = overallPercent(PipelineJob.Transcode, 1, { index: 3, count: 4 });

    expect(first).toBeLessThan(last);
    expect(last).toBe(overallPercent(PipelineJob.Transcode, 1));
  });

  it('gives a rung’s start the previous rung’s end', () => {
    expect(overallPercent(PipelineJob.Transcode, 0, { index: 1, count: 4 })).toBe(
      overallPercent(PipelineJob.Transcode, 1, { index: 0, count: 4 }),
    );
  });

  it('labels every stage for the wizard', () => {
    for (const stage of Object.values(PipelineJob)) {
      expect(stageLabel(stage).length).toBeGreaterThan(0);
    }
    expect(stageLabel(PipelineJob.Transcode, '720p')).toContain('720p');
  });
});
