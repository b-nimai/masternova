import {
  DEFAULT_PART_SIZE,
  LARGEST_PART_SIZE,
  MAX_PART_COUNT,
  MAX_PART_SIZE,
  MAX_UPLOADABLE_BYTES,
  MIN_PART_SIZE,
  partRange,
  planUpload,
} from './upload-plan';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * No database, no S3, no Nest. The part plan is the piece that has to be arithmetically
 * right, and every property worth asserting about it is checkable in memory — which is
 * the whole reason it was written as a pure function rather than a method on the service.
 */
describe('planUpload', () => {
  it('rejects an empty file', () => {
    expect(() => planUpload(0n)).toThrow(RangeError);
  });

  it('rejects a file past the multipart ceiling', () => {
    expect(() => planUpload(MAX_UPLOADABLE_BYTES + 1n)).toThrow(RangeError);
  });

  /**
   * The ceiling is the scheme's, not the provider's: part sizes are power-of-two multiples
   * of the default, and 5 GiB is not one of those. Pinned so a future tweak to
   * `DEFAULT_PART_SIZE` cannot silently start emitting parts the provider rejects.
   */
  it('keeps its largest part size inside the provider limit', () => {
    expect(LARGEST_PART_SIZE).toBe(4 * GiB);
    expect(LARGEST_PART_SIZE).toBeLessThanOrEqual(MAX_PART_SIZE);
    expect(LARGEST_PART_SIZE % DEFAULT_PART_SIZE).toBe(0);
  });

  /**
   * The most common upload there is, and the one a naive "every part must be 5 MiB" check
   * would reject: the floor applies to every part *except the last*, and a single-part
   * upload is all last part.
   */
  it('plans a file smaller than one part as a single part', () => {
    expect(planUpload(1n)).toEqual({ partSize: DEFAULT_PART_SIZE, partCount: 1 });
    expect(planUpload(BigInt(3 * MiB))).toEqual({ partSize: DEFAULT_PART_SIZE, partCount: 1 });
  });

  it('does not add an empty part on an exact multiple of the part size', () => {
    expect(planUpload(BigInt(DEFAULT_PART_SIZE)).partCount).toBe(1);
    expect(planUpload(BigInt(2 * DEFAULT_PART_SIZE)).partCount).toBe(2);
    expect(planUpload(BigInt(2 * DEFAULT_PART_SIZE) + 1n).partCount).toBe(3);
  });

  it('keeps the default part size for a typical lecture', () => {
    const plan = planUpload(BigInt(GiB));
    expect(plan.partSize).toBe(DEFAULT_PART_SIZE);
    expect(plan.partCount).toBe(128);
  });

  /**
   * The growth path. At the default size, 10 000 parts covers 80 GiB — so the first file
   * that forces a doubling is the one just past it, and it must double rather than land on
   * an unaligned exact division.
   */
  it('doubles the part size rather than exceeding the part-count ceiling', () => {
    const atCeiling = BigInt(DEFAULT_PART_SIZE) * BigInt(MAX_PART_COUNT);

    expect(planUpload(atCeiling)).toEqual({
      partSize: DEFAULT_PART_SIZE,
      partCount: MAX_PART_COUNT,
    });

    const past = planUpload(atCeiling + 1n);
    expect(past.partSize).toBe(DEFAULT_PART_SIZE * 2);
    expect(past.partCount).toBe(5001);
  });

  /**
   * The invariants that make a plan legal at the provider. Asserted across the range
   * rather than at one convenient size, because the failure mode — `EntityTooSmall` — is
   * only reported at complete time, after the whole transfer.
   */
  it.each([
    ['1 byte', 1n],
    ['5 MiB', BigInt(5 * MiB)],
    ['100 MiB', BigInt(100 * MiB)],
    ['1 GiB', BigInt(GiB)],
    ['10 GiB', BigInt(10 * GiB)],
    ['1 TiB', BigInt(1024) * BigInt(GiB)],
    ['at the ceiling', MAX_UPLOADABLE_BYTES],
  ])('produces a provider-legal plan for %s', (_label, size) => {
    const plan = planUpload(size);

    expect(plan.partCount).toBeGreaterThanOrEqual(1);
    expect(plan.partCount).toBeLessThanOrEqual(MAX_PART_COUNT);
    expect(plan.partSize).toBeLessThanOrEqual(LARGEST_PART_SIZE);
    expect(plan.partSize).toBeLessThanOrEqual(MAX_PART_SIZE);

    // Every part but the last clears the provider's floor.
    if (plan.partCount > 1) {
      expect(plan.partSize).toBeGreaterThanOrEqual(MIN_PART_SIZE);
    }
  });

  /**
   * The property that actually matters: the parts tile the file exactly — no gap, no
   * overlap, nothing past the end. A plan that loses a byte produces a corrupt video that
   * transcodes fine and fails halfway through playback.
   */
  it.each([
    ['1 byte', 1n],
    ['a part boundary', BigInt(DEFAULT_PART_SIZE)],
    ['one past a boundary', BigInt(DEFAULT_PART_SIZE) + 1n],
    ['1 GiB', BigInt(GiB)],
  ])('tiles the file exactly for %s', (_label, size) => {
    const plan = planUpload(size);
    let cursor = 0n;

    for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) {
      const { start, end } = partRange(plan, size, partNumber);
      expect(start).toBe(cursor);
      expect(end).toBeGreaterThan(start);
      cursor = end;
    }

    expect(cursor).toBe(size);
  });
});
