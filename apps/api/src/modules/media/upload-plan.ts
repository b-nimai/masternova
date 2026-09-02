/**
 * How a file of N bytes is cut into multipart parts.
 *
 * Pure, and deliberately so: this is the piece that has to be *right*, and every property
 * worth asserting about it — the parts tile the file exactly, none is under the provider's
 * minimum, the count fits the provider's ceiling — is checkable with no database, no
 * network and no S3. It is unit-tested at the boundaries in `upload-plan.spec.ts`.
 *
 * The constants are S3's, and MinIO implements the same limits, so this file stays on the
 * portable side of the `IStorageProvider` port.
 */

/** S3 rejects a non-final part below 5 MiB with `EntityTooSmall` — at complete time. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
/** A single part may not exceed 5 GiB. */
export const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
/** Parts are numbered 1..10000 inclusive. */
export const MAX_PART_COUNT = 10_000;

/**
 * The starting part size, not the only one.
 *
 * 8 MiB is a compromise the numbers pick for us: small enough that losing a part to a
 * flaky connection costs seconds rather than minutes, large enough that a 1 GB lecture is
 * 128 requests rather than 200. It grows only when the count would otherwise blow the
 * 10 000 ceiling, which starts to bite at 80 GB.
 */
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

export interface UploadPlan {
  readonly partSize: number;
  readonly partCount: number;
}

/**
 * The largest part this scheme will actually produce: 4 GiB, not the provider's 5 GiB.
 *
 * Sizes here are always `DEFAULT_PART_SIZE << n` (see `planUpload`), and 5 GiB is not one
 * of those — 8 MiB doubled lands on 4 GiB and then on 8 GiB, which the provider rejects.
 * Rather than special-case the last doubling into an unaligned 5 GiB, the scheme stops at
 * the largest aligned size that is legal. It costs 20% of a theoretical ceiling nothing
 * comes close to, and it keeps "every part size is a power-of-two multiple of the default"
 * true without an exception, which is what makes a resumed upload's boundaries predictable.
 */
export const LARGEST_PART_SIZE = (() => {
  let size = DEFAULT_PART_SIZE;
  while (size * 2 <= MAX_PART_SIZE) size *= 2;
  return size;
})();

/**
 * The largest file this scheme can carry: the biggest aligned part, ten thousand times —
 * 40 TiB. Well above any per-kind cap in `media-policy.ts`, and asserted in `policyFor`
 * so the two cannot drift.
 */
export const MAX_UPLOADABLE_BYTES = BigInt(LARGEST_PART_SIZE) * BigInt(MAX_PART_COUNT);

/**
 * Doubling rather than `ceil(size / MAX_PART_COUNT)`.
 *
 * The exact division gives the smallest legal part size, which sounds better and is worse:
 * it produces an odd number like 8 388 609 that no client buffer aligns to, for a file
 * that is one byte over a threshold. Doubling keeps every part size a power-of-two
 * multiple of the default, so a resumed upload's boundaries stay predictable, and it
 * terminates in at most ten iterations.
 */
export function planUpload(sizeBytes: bigint): UploadPlan {
  if (sizeBytes <= 0n) {
    throw new RangeError('An upload must have at least one byte');
  }
  if (sizeBytes > MAX_UPLOADABLE_BYTES) {
    throw new RangeError('File exceeds the maximum multipart upload size');
  }

  let partSize = DEFAULT_PART_SIZE;
  while (partsFor(sizeBytes, partSize) > MAX_PART_COUNT) {
    partSize *= 2;
  }

  return { partSize, partCount: partsFor(sizeBytes, partSize) };
}

/**
 * A file smaller than one part is one part, and that is legal — the 5 MiB floor applies
 * to every part *except the last*, and a single-part upload is all last part.
 */
function partsFor(sizeBytes: bigint, partSize: number): number {
  const size = BigInt(partSize);
  return Number((sizeBytes + size - 1n) / size);
}

/** The byte range part `n` covers. Used by the tests to prove the parts tile the file. */
export function partRange(
  plan: UploadPlan,
  sizeBytes: bigint,
  partNumber: number,
): { start: bigint; end: bigint } {
  const size = BigInt(plan.partSize);
  const start = BigInt(partNumber - 1) * size;
  const end = start + size < sizeBytes ? start + size : sizeBytes;
  return { start, end };
}
