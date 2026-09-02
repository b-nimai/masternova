/**
 * The ABR ladder, as **Strategy**: one profile per rung, chosen at runtime by what the
 * source actually is.
 *
 * **The force.** "Transcode the video" is not one algorithm — it is four, differing in
 * resolution, bitrate, and the buffer settings that follow from them. Left as a `switch`
 * inside the transcode job, adding a 1440p rung means editing the job (CLAUDE.md §1 O), and
 * the numbers that define a rung end up interleaved with the code that runs ffmpeg.
 *
 * As data, `ladderFor()` is a filter and a new rung is a new entry.
 *
 * Pure: no injection, no I/O, no ffmpeg. Every claim about it is a unit test.
 */

export interface TranscodeProfile {
  /** The rung name. Half of the deterministic output key, so it must never change. */
  readonly name: string;
  readonly height: number;
  /** Video bitrate, bits per second. */
  readonly videoBitrateBps: number;
  /** Audio bitrate, bits per second. */
  readonly audioBitrateBps: number;
  /**
   * The maximum decoder buffer, as a multiple of the video bitrate. 1.5× is the usual
   * compromise: enough to absorb a complex scene without letting the instantaneous rate
   * spike past what a phone on 3G can pull.
   */
  readonly bufferFactor: number;
}

/**
 * Bitrates are the widely-used H.264 ladder, not invented here — they are roughly what
 * Apple's HLS authoring spec and the Bitmovin/Mux published ladders agree on for 16:9 SDR.
 * Worth knowing they are a starting point: a real platform tunes them per-title.
 */
export const ABR_LADDER: readonly TranscodeProfile[] = [
  {
    name: '240p',
    height: 240,
    videoBitrateBps: 400_000,
    audioBitrateBps: 64_000,
    bufferFactor: 1.5,
  },
  {
    name: '480p',
    height: 480,
    videoBitrateBps: 1_200_000,
    audioBitrateBps: 96_000,
    bufferFactor: 1.5,
  },
  {
    name: '720p',
    height: 720,
    videoBitrateBps: 2_800_000,
    audioBitrateBps: 128_000,
    bufferFactor: 1.5,
  },
  {
    name: '1080p',
    height: 1080,
    videoBitrateBps: 5_000_000,
    audioBitrateBps: 128_000,
    bufferFactor: 1.5,
  },
];

/**
 * The rungs to build for a source of this height.
 *
 * **Never upscale.** A 480p source re-encoded to 1080p costs four times the CPU and the
 * storage to deliver exactly the same detail, plus a bigger download for the learner. So
 * the ladder is capped at the source, and a rung is included when it is at or below it.
 *
 * **Always produce at least one rung.** A source shorter than the lowest rung — a 144p
 * screen recording — would otherwise yield an empty ladder and a master playlist with no
 * variants, which is a player error rather than a graceful degradation. It gets the bottom
 * rung, which for once *is* an upscale, and is the right trade: one tiny file beats a
 * lecture that cannot be played at all.
 */
export function ladderFor(sourceHeight: number): readonly TranscodeProfile[] {
  const withinSource = ABR_LADDER.filter((profile) => profile.height <= sourceHeight);
  return withinSource.length > 0 ? withinSource : [ABR_LADDER[0]];
}

/** Looked up by name when a replayed job names a rung. `undefined` if the ladder changed. */
export function profileFor(name: string): TranscodeProfile | undefined {
  return ABR_LADDER.find((profile) => profile.name === name);
}

/**
 * Width is derived, never stored: it comes from the source's aspect ratio, and rounding is
 * **to an even number** because H.264's 4:2:0 chroma subsampling halves both dimensions and
 * cannot represent an odd one. ffmpeg fails outright on an odd width, which is a confusing
 * way to discover this.
 */
export function widthFor(
  profile: TranscodeProfile,
  sourceWidth: number,
  sourceHeight: number,
): number {
  const scaled = Math.round((sourceWidth * profile.height) / sourceHeight);
  return scaled % 2 === 0 ? scaled : scaled + 1;
}
