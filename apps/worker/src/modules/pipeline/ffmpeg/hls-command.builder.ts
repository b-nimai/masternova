import { widthFor, type TranscodeProfile } from '../ladder/transcode-profile';

/**
 * Builds the ffmpeg argv for one HLS rung, as **Builder**.
 *
 * **The force, and why this is the one place in the project a Builder earns its keep.** An
 * ffmpeg HLS invocation is twenty-odd flags whose *validity depends on each other*: the
 * keyframe interval must divide evenly into the segment duration or segments drift off
 * their boundaries and seeking breaks; `-maxrate` is meaningless without `-bufsize`;
 * `-hls_time` is meaningless without a matching `-g`. That is a stepwise assembly with a
 * validity condition at the end — the exact shape a Builder exists for, and the exact shape
 * that a bag of string concatenation gets subtly wrong.
 *
 * The alternative — a template string with interpolation — was rejected because it cannot
 * be *asserted*. This builds an argv array, so `hls-command.builder.spec.ts` can state that
 * the GOP divides the segment length and that no flag is silently dropped, with no ffmpeg
 * installed and no video on disk.
 *
 * Pure: no injection, no I/O, no spawning. Something else runs what this produces.
 */

/**
 * Six seconds, matching Apple's HLS authoring recommendation.
 *
 * The trade is latency against overhead: shorter segments let a player switch rungs sooner
 * on a bandwidth drop, but each one is an HTTP request and a playlist entry. Six is the
 * usual compromise for VOD, where startup latency is not the constraint it is for live.
 */
export const SEGMENT_SECONDS = 6;

/**
 * Frames per second assumed when placing keyframes.
 *
 * Deliberately fixed rather than read from the source. A keyframe interval is expressed in
 * frames, so it depends on the frame rate — and a variable-frame-rate source (every screen
 * recording) has no single answer. Forcing the output to a known rate makes the GOP
 * arithmetic exact, and 30 covers the lecture content this platform actually carries.
 */
export const OUTPUT_FPS = 30;

export interface HlsBuildInput {
  /** The source ffmpeg reads. A presigned URL — ffmpeg speaks HTTP, so nothing is staged. */
  readonly inputUrl: string;
  readonly profile: TranscodeProfile;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Local directory the segments and the variant playlist are written into. */
  readonly outputDir: string;
}

export class HlsCommandBuilder {
  private readonly args: string[] = [];

  private constructor(private readonly spec: HlsBuildInput) {}

  static for(spec: HlsBuildInput): HlsCommandBuilder {
    return new HlsCommandBuilder(spec);
  }

  /**
   * The whole command, in the order ffmpeg requires: global flags, then input, then the
   * output's codec settings, then the output. Order is not cosmetic here — ffmpeg applies
   * an option to whichever file follows it, so a codec flag placed before `-i` silently
   * configures the *input* decoder instead of the encoder.
   */
  build(): string[] {
    return this.global().input().video().audio().hls().output().args;
  }

  private global(): this {
    this.args.push(
      '-hide_banner',
      // Fail on the first error rather than writing a truncated playlist that looks fine
      // until a learner seeks into the missing part.
      '-xerror',
      '-loglevel',
      'error',
      // Overwrite: a retry of this job must be able to rewrite its own partial output.
      '-y',
    );
    return this;
  }

  private input(): this {
    this.args.push('-i', this.spec.inputUrl);
    return this;
  }

  private video(): this {
    const { profile, sourceWidth, sourceHeight } = this.spec;
    const width = widthFor(profile, sourceWidth, sourceHeight);
    const gop = this.gopSize();

    this.args.push(
      '-vf',
      `scale=${width}:${profile.height}`,
      '-c:v',
      'libx264',
      // `veryfast` over `medium`: on a CPU-bound worker fleet the queue depth is the
      // constraint, and the extra ~10% bitrate for the same quality is cheaper than
      // tripling the time a lecture waits to become playable.
      '-preset',
      'veryfast',
      '-profile:v',
      'main',
      '-b:v',
      String(profile.videoBitrateBps),
      '-maxrate',
      String(profile.videoBitrateBps),
      '-bufsize',
      String(Math.round(profile.videoBitrateBps * profile.bufferFactor)),
      // Fixed output frame rate, so the GOP arithmetic below is exact.
      '-r',
      String(OUTPUT_FPS),
      // A keyframe exactly every GOP frames, and *only* there. Both flags are required:
      // `-g` sets the maximum interval, `keyint_min` stops x264 inserting extra keyframes
      // on scene changes — which would put segment boundaries in different places in
      // different rungs, and a player switching rungs mid-stream would stutter or seek
      // backwards. Aligned boundaries across the ladder are what makes ABR switching work.
      '-g',
      String(gop),
      '-keyint_min',
      String(gop),
      '-sc_threshold',
      '0',
    );
    return this;
  }

  private audio(): this {
    this.args.push('-c:a', 'aac', '-b:a', String(this.spec.profile.audioBitrateBps), '-ac', '2');
    return this;
  }

  private hls(): this {
    this.args.push(
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_SECONDS),
      // Keep every segment in the playlist: this is VOD, not a live sliding window.
      '-hls_list_size',
      '0',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_filename',
      `${this.spec.outputDir}/segment_%05d.ts`,
    );
    return this;
  }

  private output(): this {
    this.args.push(`${this.spec.outputDir}/index.m3u8`);
    return this;
  }

  /**
   * The validity condition the whole builder exists to guarantee.
   *
   * A segment boundary can only fall on a keyframe. If the GOP does not divide evenly into
   * `hls_time × fps`, ffmpeg puts the boundary at the next keyframe instead — segments
   * drift, the rungs stop agreeing on where they start, and seeking lands in the wrong
   * place. `6 × 30 = 180`, so the GOP is 180 frames and every segment starts on one.
   */
  private gopSize(): number {
    return SEGMENT_SECONDS * OUTPUT_FPS;
  }
}
