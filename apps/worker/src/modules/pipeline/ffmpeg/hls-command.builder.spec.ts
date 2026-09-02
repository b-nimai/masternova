import { HlsCommandBuilder, OUTPUT_FPS, SEGMENT_SECONDS } from './hls-command.builder';
import { ABR_LADDER, profileFor } from '../ladder/transcode-profile';

/**
 * No ffmpeg installed, no video on disk. The Builder produces an argv array precisely so
 * these properties can be asserted rather than discovered in a DLQ entry three weeks later.
 */
describe('HlsCommandBuilder', () => {
  const build = (overrides: Partial<Parameters<typeof HlsCommandBuilder.for>[0]> = {}) =>
    HlsCommandBuilder.for({
      inputUrl: 'https://minio.test/video/abc/original?X-Amz-Signature=deadbeef',
      profile: profileFor('720p')!,
      sourceWidth: 1920,
      sourceHeight: 1080,
      outputDir: '/tmp/out',
      ...overrides,
    }).build();

  /** Read the value that follows a flag, the way ffmpeg does. */
  const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('puts codec options after the input, where they configure the encoder', () => {
    const args = build();
    // ffmpeg applies an option to whichever file follows it, so a codec flag before `-i`
    // silently configures the input *decoder* instead — and the output is untouched.
    expect(args.indexOf('-c:v')).toBeGreaterThan(args.indexOf('-i'));
    expect(args.indexOf('-c:a')).toBeGreaterThan(args.indexOf('-i'));
  });

  /**
   * The property the whole Builder exists to guarantee. A segment boundary can only land
   * on a keyframe; if the GOP does not divide `hls_time x fps`, boundaries drift, rungs
   * stop agreeing on where segments start, and switching rungs mid-playback stutters.
   */
  it('places keyframes so segment boundaries always land on one', () => {
    const args = build();
    const gop = Number(valueAfter(args, '-g'));
    const framesPerSegment = Number(valueAfter(args, '-hls_time')) * Number(valueAfter(args, '-r'));

    expect(gop).toBe(SEGMENT_SECONDS * OUTPUT_FPS);
    expect(framesPerSegment % gop).toBe(0);
  });

  it('pins the minimum keyframe interval and disables scene detection', () => {
    const args = build();
    // Without both, x264 inserts extra keyframes on scene changes — putting boundaries in
    // different places in different rungs, which is what breaks ABR switching.
    expect(valueAfter(args, '-keyint_min')).toBe(valueAfter(args, '-g'));
    expect(valueAfter(args, '-sc_threshold')).toBe('0');
  });

  it('always pairs maxrate with a bufsize', () => {
    const args = build();
    // `-maxrate` without `-bufsize` is silently ignored by x264.
    expect(args).toContain('-maxrate');
    expect(args).toContain('-bufsize');
    const profile = profileFor('720p')!;
    expect(valueAfter(args, '-bufsize')).toBe(
      String(Math.round(profile.videoBitrateBps * profile.bufferFactor)),
    );
  });

  it.each(ABR_LADDER.map((p) => p.name))('scales to an even width for the %s rung', (name) => {
    const args = build({ profile: profileFor(name)! });
    const [width, height] = valueAfter(args, '-vf').replace('scale=', '').split(':').map(Number);

    expect(width % 2).toBe(0);
    expect(height).toBe(profileFor(name)!.height);
  });

  it('writes a VOD playlist that keeps every segment', () => {
    const args = build();
    // A live sliding window would drop earlier segments, so a learner could not seek back.
    expect(valueAfter(args, '-hls_list_size')).toBe('0');
    expect(valueAfter(args, '-hls_playlist_type')).toBe('vod');
  });

  it('fails the whole command on the first error rather than truncating the playlist', () => {
    // A truncated playlist looks fine until a learner seeks into the part that is missing.
    expect(build()).toContain('-xerror');
  });

  it('writes segments and the playlist into the given directory', () => {
    const args = build({ outputDir: '/tmp/rung-720p' });
    expect(valueAfter(args, '-hls_segment_filename')).toBe('/tmp/rung-720p/segment_%05d.ts');
    expect(args[args.length - 1]).toBe('/tmp/rung-720p/index.m3u8');
  });

  it('never interpolates the input URL into a shell string', () => {
    // argv, not a shell line — so a presigned URL's `&` and `?` cannot split the command.
    const args = build();
    expect(args).toContain('https://minio.test/video/abc/original?X-Amz-Signature=deadbeef');
  });
});
