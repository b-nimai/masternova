/**
 * Direct-to-storage multipart upload: PUT presigned parts with bounded concurrency,
 * retrying transient failures, and report progress.
 *
 * Deliberately domain-free — it knows about blobs, presigned URLs and ETags, and nothing
 * about courses, lectures or any endpoint. That is what lets the instructor wizard
 * (task 3.13) and any later uploader share it without either one depending on the other.
 *
 * Carried over from Loom Lite AI's `use-video-upload.ts`, which coupled this logic to a
 * React hook and to Loom's `/videos` endpoints. Splitting the transport out of the hook
 * also makes it testable without a DOM.
 */

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadPartsOptions {
  file: Blob;
  parts: PresignedPart[];
  /** Byte size of every part except the last; used to slice the file. */
  partSize: number;
  concurrency?: number;
  maxRetriesPerPart?: number;
  onProgress?: (percent: number, bytesUploaded: number) => void;
  signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 3;

export class PartUploadError extends Error {
  constructor(
    message: string,
    readonly partNumber: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PartUploadError';
  }
}

/** PUT one part to its presigned URL, retrying transient failures; resolves to the ETag. */
async function putPart(
  part: PresignedPart,
  body: Blob,
  maxRetries: number,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetch(part.url, { method: 'PUT', body, signal });
      if (!res.ok) {
        throw new PartUploadError(`part upload failed with HTTP ${res.status}`, part.partNumber);
      }
      const etag = res.headers.get('ETag') ?? res.headers.get('etag');
      if (!etag) {
        // Not retryable: the bucket's CORS config is wrong, and it will stay wrong.
        // CompleteMultipartUpload cannot be assembled without these, so fail loudly.
        throw new PartUploadError(
          'storage did not return an ETag — the bucket CORS policy must expose the ETag header',
          part.partNumber,
        );
      }
      return etag;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      // Don't sleep after the final attempt — the original did, and it just made
      // every failure a second slower than it needed to be.
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  throw new PartUploadError(
    `part ${part.partNumber} failed after ${maxRetries} attempts`,
    part.partNumber,
    lastErr,
  );
}

/**
 * Uploads every part with a bounded worker pool and returns the completed parts in
 * part-number order, ready for CompleteMultipartUpload.
 */
export async function uploadParts({
  file,
  parts,
  partSize,
  concurrency = DEFAULT_CONCURRENCY,
  maxRetriesPerPart = DEFAULT_MAX_RETRIES,
  onProgress,
  signal,
}: UploadPartsOptions): Promise<CompletedPart[]> {
  const completed: CompletedPart[] = new Array(parts.length);
  let bytesUploaded = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < parts.length) {
      if (signal?.aborted) throw new Error('upload aborted');
      const index = cursor;
      cursor += 1;

      const part = parts[index];
      const offset = (part.partNumber - 1) * partSize;
      const blob = file.slice(offset, Math.min(offset + partSize, file.size));

      const etag = await putPart(part, blob, maxRetriesPerPart, signal);
      completed[index] = { partNumber: part.partNumber, etag };

      bytesUploaded += blob.size;
      onProgress?.(Math.round((bytesUploaded / file.size) * 100), bytesUploaded);
    }
  };

  const poolSize = Math.min(concurrency, parts.length);
  await Promise.all(Array.from({ length: poolSize }, worker));

  return completed;
}
