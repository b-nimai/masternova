import { orphansIn, type AssetInventory } from './orphan-scan';

const ASSET = 'abc';
const base: AssetInventory = {
  assetId: ASSET,
  exists: true,
  settled: true,
  renditionNames: ['240p', '480p', 'master', 'poster', 'sprite'],
};

const keys = [
  `video/${ASSET}/original`,
  `video/${ASSET}/poster.jpg`,
  `video/${ASSET}/sprite.jpg`,
  `video/${ASSET}/sprite.vtt`,
  `video/${ASSET}/hls/master.m3u8`,
  `video/${ASSET}/hls/240p/index.m3u8`,
  `video/${ASSET}/hls/240p/segment_00001.ts`,
  `video/${ASSET}/hls/480p/index.m3u8`,
  `video/${ASSET}/hls/480p/segment_00001.ts`,
];

/**
 * This function decides what gets deleted, so its rules are asserted directly rather than
 * inferred from a sweeper run. A bug here destroys a paying learner's lecture.
 */
describe('orphan scan', () => {
  it('finds nothing when every rung has a rendition', () => {
    expect(orphansIn(base, keys)).toEqual([]);
  });

  /** The case that actually happens: the ladder changed and old segments were left behind. */
  it('orphans a rung directory the database has no rendition for', () => {
    const stale = [
      ...keys,
      `video/${ASSET}/hls/1080p/index.m3u8`,
      `video/${ASSET}/hls/1080p/segment_00001.ts`,
    ];
    expect(orphansIn(base, stale)).toEqual([
      `video/${ASSET}/hls/1080p/index.m3u8`,
      `video/${ASSET}/hls/1080p/segment_00001.ts`,
    ]);
  });

  /** It is what every re-run reads, and the one object the pipeline cannot regenerate. */
  it('never orphans the source of an existing asset', () => {
    const narrow: AssetInventory = { ...base, renditionNames: [] };
    expect(orphansIn(narrow, keys)).not.toContain(`video/${ASSET}/original`);
  });

  it('never orphans the master playlist, poster or sprite', () => {
    const narrow: AssetInventory = { ...base, renditionNames: [] };
    const found = orphansIn(narrow, keys);
    expect(found).not.toContain(`video/${ASSET}/hls/master.m3u8`);
    expect(found).not.toContain(`video/${ASSET}/poster.jpg`);
    expect(found).not.toContain(`video/${ASSET}/sprite.vtt`);
  });

  /**
   * A pipeline mid-encode has half a rung on disk that no row mentions yet. Deleting it
   * races the job writing it — and the job would then upload it again.
   */
  it('yields nothing at all while the pipeline is still running', () => {
    expect(orphansIn({ ...base, settled: false, renditionNames: [] }, keys)).toEqual([]);
  });

  /** The row is gone, so nothing can ever read these bytes again — source included. */
  it('orphans the whole prefix when the asset row no longer exists', () => {
    expect(orphansIn({ ...base, exists: false }, keys)).toEqual(keys);
  });

  it('keeps anything it cannot classify', () => {
    // An unexpected shape is not evidence of an orphan; storage is cheaper than a lecture.
    const odd = [`video/${ASSET}/hls`, `video/${ASSET}/notes.txt`];
    expect(orphansIn(base, odd)).toEqual([]);
  });
});
