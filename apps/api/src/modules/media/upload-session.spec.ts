import type { AssetKind, UploadSessionStatus } from '@masternova/db';
import {
  UPLOAD_SESSION_LIFECYCLE,
  isTerminal,
  transitionOn,
  type UploadSessionEvent,
} from './upload-session';
import { MEDIA_POLICY, policyFor, storageKeyFor } from './media-policy';
import { MAX_UPLOADABLE_BYTES } from './upload-plan';

const ALL_STATES = Object.keys(UPLOAD_SESSION_LIFECYCLE) as UploadSessionStatus[];
const ALL_EVENTS: UploadSessionEvent[] = [
  'observe',
  'complete',
  'assembled',
  'release',
  'abort',
  'expire',
];

/** No database. The machine is data, so the assertions are about the data. */
describe('upload session lifecycle', () => {
  it('lets a single-part upload complete without ever reaching UPLOADING', () => {
    // The smallest and most common upload: one PUT, no status poll in between. Requiring a
    // pass through UPLOADING would break it.
    expect(transitionOn('CREATED', 'complete')?.to).toBe('COMPLETING');
  });

  /**
   * The mutex. `CompleteMultipartUpload` is not idempotent, so exactly one caller may
   * reach the provider — and the claim that grants that right is this edge.
   */
  it('routes every complete through COMPLETING rather than straight to COMPLETED', () => {
    expect(transitionOn('CREATED', 'complete')?.to).toBe('COMPLETING');
    expect(transitionOn('UPLOADING', 'complete')?.to).toBe('COMPLETING');
    expect(transitionOn('CREATED', 'assembled')).toBeUndefined();
    expect(transitionOn('UPLOADING', 'assembled')).toBeUndefined();
  });

  /**
   * A session mid-assemble must never be aborted or expired: both abort the provider's
   * multipart upload, which destroys an upload that is about to succeed.
   */
  it('refuses to abort or expire an upload that is being assembled', () => {
    expect(transitionOn('COMPLETING', 'abort')).toBeUndefined();
    expect(transitionOn('COMPLETING', 'expire')).toBeUndefined();
  });

  it('gives COMPLETING exactly two exits, both decided by the provider', () => {
    expect(transitionOn('COMPLETING', 'assembled')?.to).toBe('COMPLETED');
    expect(transitionOn('COMPLETING', 'release')?.to).toBe('UPLOADING');
    expect(isTerminal('COMPLETING')).toBe(false);
  });

  it('records the first observed part by moving CREATED to UPLOADING', () => {
    expect(transitionOn('CREATED', 'observe')?.to).toBe('UPLOADING');
  });

  it('lets a stalled upload be observed repeatedly without changing state', () => {
    // Every status poll on a live upload takes this edge; it must be a self-loop, not a
    // no-op that a caller has to special-case.
    expect(transitionOn('UPLOADING', 'observe')?.to).toBe('UPLOADING');
  });

  /**
   * The bug this machine exists to prevent: the reaper expiring a session in the same
   * second the browser completed it, leaving an asset marked FAILED whose bytes are in the
   * bucket and whose lecture 404s for every learner who paid for it.
   */
  it('refuses every event once an upload has completed', () => {
    for (const event of ALL_EVENTS) {
      expect(transitionOn('COMPLETED', event)).toBeUndefined();
    }
  });

  it.each(['COMPLETED', 'ABORTED', 'EXPIRED'] as UploadSessionStatus[])(
    '%s is terminal',
    (status) => {
      expect(isTerminal(status)).toBe(true);
      expect(UPLOAD_SESSION_LIFECYCLE[status]).toHaveLength(0);
    },
  );

  it.each(['CREATED', 'UPLOADING', 'COMPLETING'] as UploadSessionStatus[])(
    '%s is live',
    (status) => {
      expect(isTerminal(status)).toBe(false);
    },
  );

  /**
   * Every live state must have a way out, or it becomes an un-reapable leak.
   *
   * COMPLETING is excluded from the abort/expire check by design and included in the
   * "has some exit" check: its exits are `assembled` and `release`, and `release` is what
   * returns it to a state the reaper can act on.
   */
  it('gives every live state a way out', () => {
    for (const status of ALL_STATES.filter((s) => !isTerminal(s))) {
      expect(UPLOAD_SESSION_LIFECYCLE[status].length).toBeGreaterThan(0);
    }

    for (const status of ['CREATED', 'UPLOADING'] as UploadSessionStatus[]) {
      expect(transitionOn(status, 'abort')?.to).toBe('ABORTED');
      expect(transitionOn(status, 'expire')?.to).toBe('EXPIRED');
    }
  });

  /**
   * The structural guarantee, asserted rather than assumed: no path through this file
   * produces an edge the source state did not declare.
   */
  it('never offers a transition outside the source state’s declared edges', () => {
    for (const status of ALL_STATES) {
      const declared = UPLOAD_SESSION_LIFECYCLE[status];
      for (const event of ALL_EVENTS) {
        const found = transitionOn(status, event);
        if (found) expect(declared).toContain(found);
      }
    }
  });
});

describe('media policy', () => {
  const KINDS = Object.keys(MEDIA_POLICY) as AssetKind[];

  it.each(KINDS)('keeps the %s cap inside the multipart ceiling', (kind) => {
    // The assertion `policyFor` makes at runtime. Here so a raised cap fails in CI rather
    // than at complete time, after an instructor waited out the whole transfer.
    expect(() => policyFor(kind)).not.toThrow();
    expect(MEDIA_POLICY[kind].maxBytes).toBeLessThanOrEqual(MAX_UPLOADABLE_BYTES);
  });

  it('never accepts SVG as an image', () => {
    // It is a script host, and it would be served from our own origin.
    expect(MEDIA_POLICY.IMAGE.contentTypes).not.toContain('image/svg+xml');
  });

  /** The key is derived from the id alone — a filename never reaches the path. */
  it('builds a key from the asset id, not the filename', () => {
    const key = storageKeyFor('VIDEO', 'abc-123');
    expect(key).toBe('video/abc-123/original');
    expect(key).not.toContain('..');
  });

  it('gives each kind its own prefix', () => {
    const prefixes = Object.values(MEDIA_POLICY).map((policy) => policy.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
