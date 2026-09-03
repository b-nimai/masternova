/**
 * Which objects under an asset's prefix are accounted for, and which are not.
 *
 * Pure, and separated from the sweeper for the obvious reason: this decides what gets
 * **deleted**, and a bug here destroys a paying learner's lecture. Every rule is asserted
 * in `orphan-scan.spec.ts` with no bucket, no database and no chance of a real deletion.
 */

export interface AssetInventory {
  /** The asset id this prefix belongs to. */
  readonly assetId: string;
  /** `null` when no `Asset` row exists — the whole prefix is then orphaned. */
  readonly exists: boolean;
  /** Rendition names recorded in the database: the ladder rungs plus master/poster/sprite. */
  readonly renditionNames: readonly string[];
  /**
   * Whether the pipeline has finished. A running pipeline is *writing* into this prefix,
   * so nothing under it can be judged orphaned yet.
   */
  readonly settled: boolean;
}

/**
 * The keys under `video/{assetId}/` that nothing accounts for.
 *
 * **The rules, in the order they matter:**
 *
 * 1. **An unsettled asset yields nothing.** A pipeline mid-encode has half a rung on disk
 *    that no row mentions yet, and deleting it races the job that is writing it.
 * 2. **The source is never an orphan.** It is what every re-run reads, and it is the one
 *    object the pipeline cannot regenerate.
 * 3. **A missing asset row orphans everything**, source included — the row is gone, so
 *    nothing can ever read these bytes again.
 * 4. **A rung directory with no matching rendition is orphaned.** This is the case that
 *    actually happens: the ladder changed, or a transcode was retried under a name that is
 *    no longer produced, and the segments sit there billed and unreferenced forever.
 *
 * Anything this function is unsure about, it keeps. Leaving a stray object costs storage;
 * deleting a live one costs a lecture.
 */
export function orphansIn(inventory: AssetInventory, keys: readonly string[]): string[] {
  if (!inventory.exists) return [...keys];
  if (!inventory.settled) return [];

  const prefix = `video/${inventory.assetId}/`;
  const known = new Set(inventory.renditionNames);

  return keys.filter((key) => {
    const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key;

    // Rule 2 — the source, and the artifacts named directly under the prefix.
    if (!relative.startsWith('hls/')) return false;

    // `hls/<rung>/<file>`. Anything shallower is the master playlist, which is a rendition.
    const segments = relative.split('/');
    if (segments.length < 3) return false;

    // Rule 4 — a rung the database has no rendition for.
    return !known.has(segments[1]);
  });
}
