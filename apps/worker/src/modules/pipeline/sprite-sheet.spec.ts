import {
  SPRITE_COLUMNS,
  SPRITE_INTERVAL_SECONDS,
  SPRITE_MAX_TILES,
  SPRITE_TILE_HEIGHT,
  SPRITE_TILE_WIDTH,
  spriteLayout,
  spriteVtt,
} from './sprite-sheet';

describe('sprite sheet layout', () => {
  it('lays out one tile per interval for an ordinary lecture', () => {
    const layout = spriteLayout(60);
    expect(layout.tileCount).toBe(30);
    expect(layout.intervalSeconds).toBe(SPRITE_INTERVAL_SECONDS);
    expect(layout.columns).toBe(SPRITE_COLUMNS);
    expect(layout.rows).toBe(3);
  });

  it('always produces at least one tile', () => {
    expect(spriteLayout(0.5).tileCount).toBe(1);
    expect(spriteLayout(1).tileCount).toBe(1);
  });

  it('never leaves a tile without a cell', () => {
    for (const duration of [1, 7, 60, 599, 3600, 7200]) {
      const layout = spriteLayout(duration);
      expect(layout.rows * layout.columns).toBeGreaterThanOrEqual(layout.tileCount);
    }
  });

  /**
   * At one tile every two seconds a three-hour lecture would be 5400 tiles — a
   * 1600x48600 JPEG that most decoders refuse. Widening the interval keeps the sheet a
   * fixed size and degrades the preview's granularity instead, which is the right trade.
   */
  it('widens the interval rather than growing the sheet past the cap', () => {
    const long = spriteLayout(3 * 60 * 60);
    expect(long.tileCount).toBe(SPRITE_MAX_TILES);
    expect(long.intervalSeconds).toBeGreaterThan(SPRITE_INTERVAL_SECONDS);
    // And it still spans the whole video, so the last tile is near the end.
    expect(long.tileCount * long.intervalSeconds).toBeCloseTo(3 * 60 * 60, 5);
  });

  it('does not widen the interval below the cap', () => {
    const short = spriteLayout(600);
    expect(short.tileCount).toBeLessThan(SPRITE_MAX_TILES);
    expect(short.intervalSeconds).toBe(SPRITE_INTERVAL_SECONDS);
  });
});

describe('sprite WebVTT', () => {
  it('emits one cue per tile, in order, with no gaps', () => {
    const layout = spriteLayout(10);
    const vtt = spriteVtt(layout, 'sprite.jpg');
    const cues = vtt.split('\n').filter((l) => l.includes('-->'));
    expect(cues).toHaveLength(layout.tileCount);

    // Each cue starts where the previous ended — a gap means the preview blanks out.
    const ends = cues.map((c) => c.split(' --> ')[1]);
    const starts = cues.map((c) => c.split(' --> ')[0]);
    for (let i = 1; i < cues.length; i += 1) {
      expect(starts[i]).toBe(ends[i - 1]);
    }
  });

  it('uses the HH:MM:SS.mmm form WebVTT requires', () => {
    const vtt = spriteVtt(spriteLayout(4), 'sprite.jpg');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toMatch(/^00:00:00\.000 --> 00:00:02\.000$/m);
  });

  it('crosses the minute boundary correctly', () => {
    // 120s at the default 2s interval is below the cap, so cue 30 starts exactly at 1:00.
    expect(spriteVtt(spriteLayout(120), 'sprite.jpg')).toMatch(/^00:01:00\.000 --> /m);
  });

  it('formats hours on a long lecture, whose interval has been widened', () => {
    // Three hours is past the tile cap, so the interval is 12s rather than 2 — the last
    // cue must still land at the end of the video with an hours field.
    const layout = spriteLayout(3 * 60 * 60);
    const cues = spriteVtt(layout, 'sprite.jpg')
      .split('\n')
      .filter((l) => l.includes('-->'));

    expect(cues[cues.length - 1]).toMatch(/--> 03:00:00\.000$/);
    expect(cues.some((c) => c.startsWith('01:'))).toBe(true);
  });

  /** One image, cropped per cue — the reason a scrub does not fire hundreds of requests. */
  it('addresses each tile as a rectangle in the one sheet', () => {
    const layout = spriteLayout(24);
    const vtt = spriteVtt(layout, 'sprite.jpg');
    const fragments = vtt.split('\n').filter((l) => l.includes('#xywh='));

    expect(fragments).toHaveLength(layout.tileCount);
    expect(fragments[0]).toBe(`sprite.jpg#xywh=0,0,${SPRITE_TILE_WIDTH},${SPRITE_TILE_HEIGHT}`);
    // The 11th tile wraps to the second row.
    expect(fragments[SPRITE_COLUMNS]).toBe(
      `sprite.jpg#xywh=0,${SPRITE_TILE_HEIGHT},${SPRITE_TILE_WIDTH},${SPRITE_TILE_HEIGHT}`,
    );
  });

  it('never places a tile outside the sheet it declared', () => {
    const layout = spriteLayout(120);
    const vtt = spriteVtt(layout, 'sprite.jpg');
    const width = layout.columns * SPRITE_TILE_WIDTH;
    const height = layout.rows * SPRITE_TILE_HEIGHT;

    for (const line of vtt.split('\n').filter((l) => l.includes('#xywh='))) {
      const [x, y] = line.split('#xywh=')[1].split(',').map(Number);
      expect(x + SPRITE_TILE_WIDTH).toBeLessThanOrEqual(width);
      expect(y + SPRITE_TILE_HEIGHT).toBeLessThanOrEqual(height);
    }
  });
});
