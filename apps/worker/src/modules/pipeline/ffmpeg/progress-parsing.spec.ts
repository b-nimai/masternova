import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaToolsService } from './ffmpeg.service';

/**
 * Regression test for progress that jumped backwards mid-encode.
 *
 * `-progress pipe:1` is a stream of bytes, not of lines, and a chunk boundary lands wherever
 * the pipe buffer filled. The original parser called `chunk.split('\n')` and treated the
 * trailing fragment as a complete line, so `out_time_us=123456789` arriving in two writes
 * matched on `out_time_us=12` and reported 12 microseconds — the bar in BullMQ dropped to
 * ~0 halfway through a transcode.
 *
 * Driven by standing a fake `ffmpeg` in front of the adapter — a script that writes the
 * split deliberately and ignores the flags a real one would read — rather than by reaching
 * into a private method. What is asserted is the adapter's behaviour, not the shape of its
 * internals, and there is no real ffmpeg anywhere near it, so it stays a unit test.
 */
describe('MediaToolsService progress parsing', () => {
  let dir: string;

  /** A fake ffmpeg: ignores argv, writes the given JS to stdout's pipe. */
  const fakeFfmpeg = (body: string): string => {
    const script = join(dir, 'emit.js');
    const shim = join(dir, 'ffmpeg');
    writeFileSync(script, body);
    writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${script}\n`);
    chmodSync(shim, 0o755);
    return shim;
  };

  const toolsRunning = (body: string): MediaToolsService =>
    new MediaToolsService({
      ffmpegPath: fakeFfmpeg(body),
      ffprobePath: process.execPath,
    } as never);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-progress-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never reports a fraction from a half-received line', async () => {
    // `out_time_us=6000000` straddling two writes: the old parser matched `out_time_us=60`
    // and reported 60 microseconds of a 12-second encode.
    const tools = toolsRunning(
      [
        "process.stdout.write('out_time_us=60');",
        'setTimeout(() => {',
        "  process.stdout.write('00000\\nprogress=continue\\n');",
        '  process.exit(0);',
        '}, 20);',
      ].join('\n'),
    );

    const seen: number[] = [];
    await tools.run(['-i', 'in.mp4'], 12, (fraction) => seen.push(fraction));

    // One reading, from the reassembled line: 6s of 12s.
    expect(seen).toEqual([0.5]);
  });

  it('is monotonic when the stream is split at every single byte', async () => {
    const tools = toolsRunning(
      [
        "const line = 'out_time_us=3000000\\nout_time_us=6000000\\nout_time_us=9000000\\n';",
        'let i = 0;',
        'const tick = () => {',
        '  if (i >= line.length) return process.exit(0);',
        '  process.stdout.write(line[i++]);',
        '  setImmediate(tick);',
        '};',
        'tick();',
      ].join('\n'),
    );

    const seen: number[] = [];
    await tools.run(['-i', 'in.mp4'], 12, (fraction) => seen.push(fraction));

    expect(seen).toEqual([0.25, 0.5, 0.75]);
  });
});
