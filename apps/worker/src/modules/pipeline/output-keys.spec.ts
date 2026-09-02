import {
  assetPrefix,
  masterPlaylistKey,
  posterKey,
  segmentKey,
  sourceKey,
  spriteImageKey,
  spriteVttKey,
  variantPlaylistKey,
} from './output-keys';

/**
 * The key scheme is the idempotency mechanism, so its properties are worth asserting
 * directly rather than inferring from a passing pipeline run.
 */
describe('output keys', () => {
  const ASSET = 'abc-123';

  it('is deterministic — the same inputs always give the same key', () => {
    // If this were ever time- or random-seeded, a redelivered job would write a *second*
    // object instead of overwriting its own, and every retry would leak storage.
    expect(variantPlaylistKey(ASSET, '720p')).toBe(variantPlaylistKey(ASSET, '720p'));
    expect(masterPlaylistKey(ASSET)).toBe(masterPlaylistKey(ASSET));
  });

  it('puts every artifact under the asset prefix the sweeper walks', () => {
    const prefix = assetPrefix(ASSET);
    for (const key of [
      sourceKey(ASSET),
      variantPlaylistKey(ASSET, '480p'),
      segmentKey(ASSET, '480p', 'segment_00001.ts'),
      masterPlaylistKey(ASSET),
      posterKey(ASSET),
      spriteImageKey(ASSET),
      spriteVttKey(ASSET),
    ]) {
      expect(key.startsWith(prefix)).toBe(true);
    }
  });

  it('gives every artifact a distinct key', () => {
    const keys = [
      sourceKey(ASSET),
      variantPlaylistKey(ASSET, '240p'),
      variantPlaylistKey(ASSET, '1080p'),
      masterPlaylistKey(ASSET),
      posterKey(ASSET),
      spriteImageKey(ASSET),
      spriteVttKey(ASSET),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('separates rungs, so one rung’s segments cannot overwrite another’s', () => {
    // Both rungs name their segments `segment_00001.ts` — only the prefix keeps them apart.
    expect(segmentKey(ASSET, '240p', 'segment_00001.ts')).not.toBe(
      segmentKey(ASSET, '720p', 'segment_00001.ts'),
    );
  });

  it('separates assets', () => {
    expect(masterPlaylistKey('a')).not.toBe(masterPlaylistKey('b'));
  });

  it('agrees with the API on where the source lives', () => {
    // `media-policy.ts` in apps/api builds this key at upload time. If the two drift, the
    // pipeline probes a key that does not exist and the sweeper deletes one that does.
    expect(sourceKey(ASSET)).toBe(`video/${ASSET}/original`);
  });
});
