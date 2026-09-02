import type { UploadSessionStatus } from '@masternova/db';

/**
 * The upload transfer lifecycle, as **State**:
 * `CREATED → UPLOADING → COMPLETED`, with `ABORTED` and `EXPIRED` as the two ways it ends
 * badly.
 *
 * **The force.** Three actors race for this row and none of them can see the others: the
 * browser (completing), the instructor in another tab (aborting), and the reaper (expiring
 * a session whose provider-side upload is about to be reclaimed). Without a machine, the
 * reaper can expire a session in the same second the browser completes it, and the result
 * is an asset marked FAILED whose bytes are sitting in the bucket, referenced by a lecture
 * that will 404 for every learner who bought the course.
 *
 * **Shape follows `catalog/lifecycle/course-lifecycle.ts` deliberately.** That file argued
 * the edge list is the interesting content and a class per state buries it; the same
 * argument holds here and the second instance is what makes it a convention rather than a
 * one-off. Five states × four events would be twenty methods, sixteen of them `throw`.
 *
 * Pure: no injection, no I/O. The services apply the plan this file produces, and every
 * assertion about it is a unit test with no database.
 */

export type UploadSessionEvent =
  'observe' | 'complete' | 'assembled' | 'release' | 'abort' | 'expire';

export interface UploadSessionTransition {
  readonly to: UploadSessionStatus;
  readonly on: UploadSessionEvent;
}

const t = (on: UploadSessionEvent, to: UploadSessionStatus): UploadSessionTransition => ({
  on,
  to,
});

const ABORT = t('abort', 'ABORTED');
const EXPIRE = t('expire', 'EXPIRED');

export const UPLOAD_SESSION_LIFECYCLE: Readonly<
  Record<UploadSessionStatus, readonly UploadSessionTransition[]>
> = {
  /**
   * `complete` is reachable straight from CREATED, and that is not a shortcut to close.
   * A file under one part size is uploaded in a single PUT, and the client may never call
   * the status endpoint at all — so requiring a pass through UPLOADING would fail the
   * smallest, most common upload there is.
   */
  CREATED: [t('observe', 'UPLOADING'), t('complete', 'COMPLETING'), ABORT, EXPIRE],

  /**
   * UPLOADING exists because the reaper needs to tell "started and stalled" from "never
   * started", and because it is what the progress bar reads. It is entered by `observe`
   * — the status call noticing that the provider is holding at least one part — which is
   * the only way the API ever learns a byte moved.
   */
  UPLOADING: [t('observe', 'UPLOADING'), t('complete', 'COMPLETING'), ABORT, EXPIRE],

  /**
   * The assemble is in flight, and this state is the mutex that makes it exclusive.
   *
   * **Why it cannot be aborted or expired.** Both of those abort the provider's multipart
   * upload, and doing that to an assemble already in progress destroys an upload that is
   * about to succeed. A session here resolves one of exactly two ways: `assembled`, once
   * the object is confirmed to exist, or `release` back to UPLOADING when it does not —
   * which returns it to a state the reaper *can* deal with. Neither edge is a guess:
   * `objectExists` is what distinguishes them.
   */
  COMPLETING: [t('assembled', 'COMPLETED'), t('release', 'UPLOADING')],

  /**
   * All three ends are terminal. COMPLETED especially: an expire arriving after a
   * successful complete must be refused, not applied, because "abort the multipart upload"
   * against a finished object is how you delete a lecture nobody asked you to delete.
   */
  COMPLETED: [],
  ABORTED: [],
  EXPIRED: [],
};

/** `undefined` when the edge does not exist — the caller decides what that means. */
export function transitionOn(
  from: UploadSessionStatus,
  event: UploadSessionEvent,
): UploadSessionTransition | undefined {
  return UPLOAD_SESSION_LIFECYCLE[from].find((transition) => transition.on === event);
}

/** A session that has stopped moving. The reaper skips these; the client stops polling. */
export function isTerminal(status: UploadSessionStatus): boolean {
  return UPLOAD_SESSION_LIFECYCLE[status].length === 0;
}
