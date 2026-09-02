/**
 * Where every pipeline output lives in the bucket.
 *
 * **This file is the idempotency mechanism.** Every key is a pure function of the asset id
 * and the artifact's name — nothing time-based, nothing random, nothing the user typed. So
 * a redelivered job writes over its own previous output instead of creating a second copy,
 * and "run it twice" is safe without any coordination between the two runs.
 *
 * It mirrors `media-policy.ts` in the API, which derives the *source* key the same way. The
 * two must agree on the `video/{assetId}/` prefix, because the reconciliation sweeper walks
 * that prefix and anything it cannot account for is an orphan.
 *
 * Pure: no injection, no I/O. Unit-tested, because a key scheme that drifts silently
 * orphans every object already written under the old one.
 */

/** Everything belonging to one asset, source included. What the sweeper lists. */
export function assetPrefix(assetId: string): string {
  return `video/${assetId}/`;
}

/** The uploaded source, written by task 1.6. Repeated here so the sweeper knows to keep it. */
export function sourceKey(assetId: string): string {
  return `video/${assetId}/original`;
}

/** One rung's variant playlist. What the master points at. */
export function variantPlaylistKey(assetId: string, rung: string): string {
  return `video/${assetId}/hls/${rung}/index.m3u8`;
}

/** One segment within a rung. `index` is the number ffmpeg assigned it. */
export function segmentKey(assetId: string, rung: string, segment: string): string {
  return `video/${assetId}/hls/${rung}/${segment}`;
}

/** The master playlist. The single URL a player is ever given. */
export function masterPlaylistKey(assetId: string): string {
  return `video/${assetId}/hls/master.m3u8`;
}

export function posterKey(assetId: string): string {
  return `video/${assetId}/poster.jpg`;
}

export function spriteImageKey(assetId: string): string {
  return `video/${assetId}/sprite.jpg`;
}

/** The WebVTT index that maps a timestamp to a tile in the sprite image. */
export function spriteVttKey(assetId: string): string {
  return `video/${assetId}/sprite.vtt`;
}

/**
 * The rendition names the pipeline uses for non-ladder artifacts.
 *
 * Constants rather than string literals at each call site: the name is half of the
 * `(assetId, name)` unique constraint that makes an upsert idempotent, so a typo in one of
 * five places would create a second row that never gets overwritten.
 */
export const MASTER_RENDITION = 'master';
export const POSTER_RENDITION = 'poster';
export const SPRITE_RENDITION = 'sprite';
