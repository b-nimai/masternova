/** Injection token for the ffmpeg/ffprobe process runner. */
export const MEDIA_TOOLS = Symbol('MEDIA_TOOLS');

/** What ffprobe tells us about a source, reduced to what the pipeline actually decides on. */
export interface ProbeResult {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

/**
 * Progress, as a fraction of the source already processed.
 *
 * ffmpeg reports the output timestamp it has reached, so dividing by the known duration
 * gives a real percentage rather than a spinner. This is what reaches the wizard over SSE.
 */
export type ProgressCallback = (fraction: number) => void;

/**
 * The pipeline's one external dependency, behind a port.
 *
 * **The force.** ffmpeg is a process, not a library: it fails by exit code, reports progress
 * on a pipe, and is not installed in a unit test. Every processor above this line would
 * otherwise have to spawn, parse and clean up — and none of them could be tested without a
 * 200 MB binary and a real video file.
 *
 * **What is deliberately NOT here: a `transcodeTo720p()` method.** The port takes an argv
 * array because the interesting decisions — the ABR ladder, the keyframe alignment — belong
 * to `HlsCommandBuilder` and `transcode-profile.ts`, which are pure and unit-tested. A port
 * that took a rung name would have to know the ladder, and the ladder would become
 * untestable without ffmpeg. This runs what it is given and reports what happened.
 *
 * The seam is real, not speculative: `FakeMediaTools` drives every processor test, and
 * task 1.16's Whisper transcription is a second tool behind the same runner.
 */
export interface IMediaTools {
  /** ffprobe the source, parsed into the handful of fields the pipeline decides on. */
  probe(inputUrl: string): Promise<ProbeResult>;

  /**
   * Run ffmpeg with an argv the caller built.
   *
   * `totalSeconds` is passed in rather than probed here so progress is a fraction of the
   * *source*, which is the number the wizard wants — ffmpeg only knows how far it has got.
   */
  run(args: readonly string[], totalSeconds?: number, onProgress?: ProgressCallback): Promise<void>;
}
