import {
  FORBIDDEN_IN_JOB_ID,
  packageJobId,
  posterJobId,
  probeJobId,
  spriteJobId,
  transcodeJobId,
} from './job-ids';

const ASSET = 'b4b2c0f1-1f2e-4a0c-9a1b-3d5e7f9a0c11';

describe('deterministic job ids', () => {
  const all = (assetId: string) => [
    probeJobId(assetId),
    transcodeJobId(assetId, '240p'),
    transcodeJobId(assetId, '1080p'),
    packageJobId(assetId),
    posterJobId(assetId),
    spriteJobId(assetId),
  ];

  /**
   * BullMQ reserves `:` for its own Redis key structure and throws `Custom Id cannot
   * contain :` at enqueue time. The first version of this scheme used colons and every
   * fan-out failed — caught by the integration test, not by review.
   */
  it('never contains a character BullMQ rejects', () => {
    for (const id of all(ASSET)) {
      expect(id).not.toContain(FORBIDDEN_IN_JOB_ID);
      expect(id).not.toContain('.');
    }
  });

  /** The dedupe: the same asset must always produce the same id, or a replay adds a copy. */
  it('is deterministic', () => {
    expect(probeJobId(ASSET)).toBe(probeJobId(ASSET));
    expect(transcodeJobId(ASSET, '720p')).toBe(transcodeJobId(ASSET, '720p'));
  });

  it('gives the five jobs for one asset distinct ids', () => {
    const ids = all(ASSET);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('separates assets', () => {
    expect(probeJobId('a')).not.toBe(probeJobId('b'));
  });

  it('separates rungs', () => {
    expect(transcodeJobId(ASSET, '240p')).not.toBe(transcodeJobId(ASSET, '480p'));
  });
});
