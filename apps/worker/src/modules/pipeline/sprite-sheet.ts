/**
 * The scrubbing filmstrip's geometry and its WebVTT index.
 *
 * Pure, and separated from the processor for the usual reason: the arithmetic is the part
 * that can be wrong — an off-by-one in the tile count puts every thumbnail one interval out
 * and the preview shows the wrong moment — and it is checkable with no ffmpeg and no image.
 */

/** One tile per interval. Two seconds is the usual granularity for a scrub preview. */
export const SPRITE_INTERVAL_SECONDS = 2;
export const SPRITE_TILE_WIDTH = 160;
export const SPRITE_TILE_HEIGHT = 90;
/** Tiles per row in the sheet. 10 keeps a one-hour lecture's sheet under 4K wide. */
export const SPRITE_COLUMNS = 10;

/**
 * A cap on total tiles, and why it exists.
 *
 * At one tile every two seconds, a three-hour lecture is 5400 tiles — a 1600×48600 JPEG
 * that most decoders refuse and every browser chokes on. Past the cap the interval widens
 * instead, so the sheet stays a fixed size and the preview gets coarser, which is the right
 * degradation: a slightly stale thumbnail beats a preview that fails to load.
 */
export const SPRITE_MAX_TILES = 900;

export interface SpriteLayout {
  readonly tileCount: number;
  readonly columns: number;
  readonly rows: number;
  /** Seconds between tiles. Widens past `SPRITE_MAX_TILES` rather than growing the sheet. */
  readonly intervalSeconds: number;
}

export function spriteLayout(durationSeconds: number): SpriteLayout {
  const wanted = Math.max(1, Math.ceil(durationSeconds / SPRITE_INTERVAL_SECONDS));

  const tileCount = Math.min(wanted, SPRITE_MAX_TILES);
  const intervalSeconds =
    tileCount < wanted ? durationSeconds / tileCount : SPRITE_INTERVAL_SECONDS;

  const columns = Math.min(SPRITE_COLUMNS, tileCount);
  return { tileCount, columns, rows: Math.ceil(tileCount / columns), intervalSeconds };
}

/**
 * The WebVTT index a player reads to map "the pointer is at 4:12" to a rectangle in the
 * sheet. The `#xywh=` media fragment is what makes one image serve every thumbnail.
 */
export function spriteVtt(layout: SpriteLayout, imageUrl: string): string {
  const lines = ['WEBVTT', ''];

  for (let i = 0; i < layout.tileCount; i += 1) {
    const start = i * layout.intervalSeconds;
    const end = (i + 1) * layout.intervalSeconds;
    const x = (i % layout.columns) * SPRITE_TILE_WIDTH;
    const y = Math.floor(i / layout.columns) * SPRITE_TILE_HEIGHT;

    lines.push(`${timestamp(start)} --> ${timestamp(end)}`);
    lines.push(`${imageUrl}#xywh=${x},${y},${SPRITE_TILE_WIDTH},${SPRITE_TILE_HEIGHT}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** `HH:MM:SS.mmm`, which is the only timestamp format WebVTT accepts. */
function timestamp(seconds: number): string {
  const whole = Math.floor(seconds);
  const ms = Math.round((seconds - whole) * 1000);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${String(ms).padStart(3, '0')}`;
}
