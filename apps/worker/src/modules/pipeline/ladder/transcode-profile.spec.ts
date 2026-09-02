import { ABR_LADDER, ladderFor, profileFor, widthFor } from './transcode-profile';

/** No ffmpeg, no queue, no database. The ladder is data, so the assertions are about data. */
describe('ABR ladder', () => {
  it('caps the ladder at the source height rather than upscaling', () => {
    // A 480p source re-encoded to 1080p costs 4x the CPU and storage for exactly the same
    // detail, and hands the learner a bigger download for no benefit.
    expect(ladderFor(480).map((p) => p.name)).toEqual(['240p', '480p']);
    expect(ladderFor(720).map((p) => p.name)).toEqual(['240p', '480p', '720p']);
    expect(ladderFor(1080).map((p) => p.name)).toEqual(['240p', '480p', '720p', '1080p']);
  });

  it('does not add rungs above a 4K source either — the ladder is the ladder', () => {
    expect(ladderFor(2160).map((p) => p.name)).toEqual(['240p', '480p', '720p', '1080p']);
  });

  /**
   * The degenerate case. An empty ladder would produce a master playlist with no variants,
   * which is a player error rather than a graceful degradation — one tiny file beats a
   * lecture that cannot be played at all.
   */
  it('always yields at least one rung, even for a source below the lowest', () => {
    expect(ladderFor(144).map((p) => p.name)).toEqual(['240p']);
    expect(ladderFor(1).map((p) => p.name)).toEqual(['240p']);
  });

  it('orders rungs from smallest to largest, which is the order a master lists them', () => {
    const heights = ABR_LADDER.map((p) => p.height);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
  });

  it('increases bitrate with resolution', () => {
    for (let i = 1; i < ABR_LADDER.length; i += 1) {
      expect(ABR_LADDER[i].videoBitrateBps).toBeGreaterThan(ABR_LADDER[i - 1].videoBitrateBps);
    }
  });

  /** Rung names are half of a deterministic storage key, so a rename orphans every object. */
  it('keeps rung names stable and unique', () => {
    const names = ABR_LADDER.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['240p', '480p', '720p', '1080p']);
  });

  it('resolves a replayed job’s rung by name, and reports a rung that no longer exists', () => {
    expect(profileFor('720p')?.height).toBe(720);
    expect(profileFor('1440p')).toBeUndefined();
  });

  describe('width derivation', () => {
    it('preserves the source aspect ratio', () => {
      const p = ABR_LADDER.find((x) => x.name === '720p')!;
      expect(widthFor(p, 1920, 1080)).toBe(1280);
    });

    /**
     * H.264's 4:2:0 chroma subsampling halves both dimensions, so an odd width cannot be
     * represented and ffmpeg fails outright — a confusing way to discover this.
     */
    it.each([
      [1920, 1080],
      [1440, 1080],
      [1280, 720],
      [640, 480],
      [1000, 563],
      [1001, 999],
      [853, 480],
    ])('always produces an even width for a %ix%i source', (w, h) => {
      for (const profile of ABR_LADDER) {
        expect(widthFor(profile, w, h) % 2).toBe(0);
      }
    });

    it('handles a portrait source without inverting it', () => {
      const p = ABR_LADDER.find((x) => x.name === '480p')!;
      // 1080x1920 at 480 high is 270 wide, rounded up to 270 (even).
      expect(widthFor(p, 1080, 1920)).toBe(270);
    });
  });
});
