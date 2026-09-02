import type { AssetKind } from '@masternova/db';
import { MAX_UPLOADABLE_BYTES } from './upload-plan';

/**
 * What each kind of asset is allowed to be. One table, because these three facts —
 * accepted types, size cap, storage prefix — always change together, and splitting them
 * across three services is how a new kind ends up accepted by two of them.
 *
 * **Why an allow-list and not a deny-list.** The alternative, blocking `.exe` and friends,
 * is unbounded: the list of things a browser will helpfully execute grows faster than
 * anyone maintains it. Naming the six types the product actually serves means a new one is
 * a deliberate line in this file.
 *
 * **The cap is declared, not measured.** The client tells us `sizeBytes` and we plan the
 * upload from it; a lying client gets a plan it cannot fill, and the completion check
 * catches the mismatch against what the provider actually holds. The cap's job is to stop
 * an honest 400 GB upload from being planned at all, not to be the security boundary.
 */
export interface KindPolicy {
  readonly contentTypes: readonly string[];
  readonly maxBytes: bigint;
  /** First path segment in the bucket. Also what a lifecycle rule keys off in prod. */
  readonly prefix: string;
}

const GiB = 1024n * 1024n * 1024n;
const MiB = 1024n * 1024n;

export const MEDIA_POLICY: Readonly<Record<AssetKind, KindPolicy>> = {
  /**
   * The source recording. Generous, because this is the one file an instructor cannot
   * make smaller without re-exporting, and 10 GB covers a 4K hour.
   *
   * Only container formats ffmpeg reads without a licensed decoder — the transcode job
   * (1.7) is what has to open these, so accepting something it will choke on just moves
   * the failure from a fast 415 to a slow DLQ entry.
   */
  VIDEO: {
    contentTypes: ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm'],
    maxBytes: 10n * GiB,
    prefix: 'video',
  },

  /** Thumbnails and instructor avatars. SVG is absent on purpose: it is a script host. */
  IMAGE: {
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 10n * MiB,
    prefix: 'image',
  },

  /** Course resources — slides, worksheets. Served as a download, never rendered inline. */
  ATTACHMENT: {
    contentTypes: [
      'application/pdf',
      'application/zip',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    maxBytes: 512n * MiB,
    prefix: 'attachment',
  },
};

/**
 * Checked once, at import, rather than on every call.
 *
 * A cap raised past what multipart can carry would otherwise surface as a failed assemble
 * — after the instructor waited out the entire transfer. Making it a boot assertion turns
 * that into a process that refuses to start, which is the correct blast radius for a
 * configuration mistake: it fails in CI, not in front of a user.
 *
 * `throw new Error` is right here and nowhere else in this file: there is no request in
 * flight to shape a response for, and an `HttpException` raised at module load would be
 * caught by nothing.
 */
for (const [kind, policy] of Object.entries(MEDIA_POLICY)) {
  if (policy.maxBytes > MAX_UPLOADABLE_BYTES) {
    // eslint-disable-next-line no-restricted-syntax -- boot-time assertion, not a request path
    throw new Error(`media policy for ${kind} exceeds the multipart ceiling`);
  }
}

export function policyFor(kind: AssetKind): KindPolicy {
  return MEDIA_POLICY[kind];
}

/**
 * The object key, derived from the asset id and nothing the user typed.
 *
 * **Deterministic on purpose.** The key is fixed when the session is created, before a
 * byte moves, which is what makes completing an upload twice harmless — the second call
 * addresses the same object. Task 1.7 relies on the same property to make transcode
 * outputs idempotent, and it derives its keys from this prefix.
 *
 * The original filename is a column, not a path segment: it is attacker-controlled, may
 * contain `../`, and two instructors uploading `intro.mp4` must not collide.
 */
export function storageKeyFor(kind: AssetKind, assetId: string): string {
  return `${policyFor(kind).prefix}/${assetId}/original`;
}
