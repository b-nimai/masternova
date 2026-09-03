import { posterOffset } from './probe.processor';

/**
 * Regression tests for a clamp that was inverted.
 *
 * The original read `Math.max(1, Math.min(d * 0.1, d - 1))`, where the 1-second floor is
 * applied *last* and therefore overrides the upper bound for anything shorter than ~1.1s.
 * A 1-second source produced `atSeconds = 1 = duration`: ffmpeg seeks past the final frame,
 * writes no file, and the poster job dies on an ENOENT that burns all five attempts.
 */
describe('posterOffset', () => {
  it('takes the frame at 10% for a normal lecture', () => {
    expect(posterOffset(600)).toBe(60);
  });

  it('never seeks past the end of a short source', () => {
    for (const duration of [0.5, 1, 1.05, 1.1, 2, 5]) {
      expect(posterOffset(duration)).toBeLessThan(duration);
      expect(posterOffset(duration)).toBeGreaterThanOrEqual(0);
    }
  });

  it('still prefers one second in once the source is long enough to allow it', () => {
    expect(posterOffset(5)).toBe(1);
    expect(posterOffset(20)).toBe(2);
  });

  it('is zero for a duration ffprobe could not determine', () => {
    expect(posterOffset(0)).toBe(0);
    expect(posterOffset(Number.NaN)).toBe(0);
    expect(posterOffset(-3)).toBe(0);
  });
});
