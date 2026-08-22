'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export type UploadPhase = 'idle' | 'uploading' | 'finalizing' | 'done' | 'error';

const MAX_CONCURRENT = 4;
const MAX_PART_RETRIES = 3;

/** PUT one part to its presigned URL, retrying transient failures; returns the S3 ETag. */
async function putPart(url: string, body: Blob): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'PUT', body });
      if (!res.ok) {
        throw new Error(`part upload failed with HTTP ${res.status}`);
      }
      const etag = res.headers.get('ETag') ?? res.headers.get('etag');
      if (!etag) {
        throw new Error('S3 did not return an ETag (check MinIO CORS expose-headers)');
      }
      return etag;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * attempt)); // linear backoff
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('part upload failed');
}

interface UseVideoUpload {
  phase: UploadPhase;
  progress: number;
  error: string | null;
  busy: boolean;
  start: (file: File, title?: string) => Promise<void>;
  reset: () => void;
}

/**
 * Direct-to-storage multipart upload: opens a session, PUTs parts with bounded concurrency,
 * finalizes, then redirects to the dashboard. Aborts the session on failure.
 */
export function useVideoUpload(): UseVideoUpload {
  const router = useRouter();
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const uploadedBytes = useRef(0);

  const reset = useCallback(() => {
    setPhase('idle');
    setProgress(0);
    setError(null);
    uploadedBytes.current = 0;
  }, []);

  const start = useCallback(
    async (file: File, title?: string) => {
      setPhase('uploading');
      setError(null);
      setProgress(0);
      uploadedBytes.current = 0;

      let videoId: string | null = null;
      try {
        const session = await api.createUpload({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          title: title?.trim() || undefined,
        });
        videoId = session.videoId;
        const { partSize, parts } = session;
        const etags: { partNumber: number; etag: string }[] = new Array(parts.length);

        // Bounded-concurrency worker pool over the part list.
        let cursor = 0;
        const worker = async () => {
          while (cursor < parts.length) {
            const index = cursor++;
            const part = parts[index];
            const start = (part.partNumber - 1) * partSize;
            const blob = file.slice(start, Math.min(start + partSize, file.size));
            const etag = await putPart(part.url, blob);
            etags[index] = { partNumber: part.partNumber, etag };
            uploadedBytes.current += blob.size;
            setProgress(Math.round((uploadedBytes.current / file.size) * 100));
          }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, parts.length) }, worker));

        setPhase('finalizing');
        await api.completeUpload(videoId, { parts: etags });
        setPhase('done');
        setTimeout(() => router.push('/dashboard'), 800);
      } catch (err) {
        setPhase('error');
        setError(err instanceof ApiError ? err.message : (err as Error).message);
        if (videoId) {
          void api.abortUpload(videoId).catch(() => undefined);
        }
      }
    },
    [router],
  );

  const busy = phase === 'uploading' || phase === 'finalizing';

  return { phase, progress, error, busy, start, reset };
}
