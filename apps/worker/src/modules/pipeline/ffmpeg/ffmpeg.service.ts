import { spawn } from 'node:child_process';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { mediaToolsConfig } from '../../../config/configuration';
import type { IMediaTools, ProbeResult, ProgressCallback } from './ffmpeg.interface';

/**
 * How much of ffmpeg's stderr to keep for the error message.
 *
 * ffmpeg is verbose on failure and the useful line is almost always the last one, but the
 * lines before it carry the context. Keeping a bounded tail means a DLQ entry explains
 * itself without a megabyte of codec banner in the database.
 */
const STDERR_TAIL_BYTES = 4_000;

/**
 * The ffmpeg/ffprobe adapter (Adapter): a pair of command-line tools translated into the
 * `IMediaTools` port the pipeline speaks.
 *
 * **`spawn`, never `exec`.** `exec` runs the command through a shell, and every input here
 * is a **presigned URL** containing `?`, `&` and `=`. One of those in a shell string is a
 * command injection against our own worker. `spawn` with an argv array never involves a
 * shell, so the URL is a single opaque argument no matter what is in it.
 */
@Injectable()
export class MediaToolsService implements IMediaTools {
  private readonly logger = new Logger(MediaToolsService.name);

  constructor(
    @Inject(mediaToolsConfig.KEY) private readonly config: ConfigType<typeof mediaToolsConfig>,
  ) {}

  async probe(inputUrl: string): Promise<ProbeResult> {
    const raw = await this.capture(this.config.ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputUrl,
    ]);

    const parsed = JSON.parse(raw) as {
      format?: { duration?: string };
      streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
      }[];
    };

    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    // A file with no video stream is not a lecture — an MP3 renamed to .mp4, or an upload
    // that finished truncated. Failing here keeps it out of the ladder, where it would
    // produce four empty renditions and a master playlist nothing can play.
    if (!video?.width || !video.height) {
      throw new Error('The source has no decodable video stream');
    }

    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('The source has no readable duration');
    }

    return {
      durationSeconds: duration,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    };
  }

  /**
   * `-progress pipe:1` makes ffmpeg emit machine-readable `key=value` lines on stdout,
   * which is the only reliable way to read progress — the human-facing stderr line is
   * carriage-return-overwritten and its format is not stable across versions.
   */
  async run(
    args: readonly string[],
    totalSeconds?: number,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const withProgress =
      onProgress && totalSeconds ? ['-progress', 'pipe:1', '-nostats', ...args] : [...args];

    // Stdout arrives in chunks, not in lines, and a chunk boundary falls wherever the pipe
    // buffer happened to fill. `out_time_us=123456789` split as `out_time_us=12` /
    // `3456789` matches the pattern on its first half and reports 12 microseconds — the
    // per-job progress in BullMQ would jump back to ~0 in the middle of an encode. The tail
    // of each chunk is therefore carried into the next one and only parsed once terminated.
    let pending = '';

    await this.capture(this.config.ffmpegPath, withProgress, (chunk) => {
      if (!onProgress || !totalSeconds) return;

      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        // `out_time_us` is the output timestamp reached, in microseconds.
        const match = /^out_time_us=(\d+)$/.exec(line.trim());
        if (!match) continue;
        const seconds = Number(match[1]) / 1_000_000;
        onProgress(Math.min(1, seconds / totalSeconds));
      }
    });
  }

  /**
   * One place that spawns, so the failure shape is identical for both tools: a non-zero
   * exit becomes an Error carrying a bounded tail of stderr, and a missing binary becomes
   * a clear message rather than an ENOENT that reads like a filesystem bug.
   */
  private capture(
    tool: string,
    args: readonly string[],
    onStdout?: (chunk: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(tool, [...args]);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (onStdout) onStdout(text);
        else stdout += text;
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
      });

      child.on('error', (error) => {
        reject(
          new Error(
            `${tool} could not be started (${error.message}). Is it installed in this image?`,
          ),
        );
      });

      child.on('close', (code, signal) => {
        if (code === 0) return resolve(stdout);

        // A null exit code means the process was *killed*, and the signal is the only
        // evidence of why. SIGKILL here is almost always the OOM killer on a worker sized
        // too small for the resolution it was handed — a completely different problem from
        // a malformed input, and indistinguishable without this.
        const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
        this.logger.error(`${tool} ${how}: ${stderr.trim()}`);
        reject(new Error(`${tool} ${how}: ${stderr.trim().split('\n').pop() ?? 'no output'}`));
      });
    });
  }
}
