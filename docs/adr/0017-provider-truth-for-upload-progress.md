# ADR-0017 — The storage provider is the authority on upload progress, not our database

**Status:** accepted · **Date:** 2026-09-02 · **Deciders:** Nimai

## Context

Media uploads are resumable multipart transfers. The browser is handed presigned URLs and
PUTs each part **directly to object storage** — the API is deliberately not in the data
path, because proxying a 10 GB lecture would pin a Node process for an hour and pay for
every byte twice.

That architectural choice creates the problem this ADR settles: **the API never observes a
part landing.** A part is uploaded by a browser talking to S3, and the only two entities
that know it happened are the browser and S3. The browser is a process we do not control
and which is allowed to die at any moment — closing the laptop mid-upload is the ordinary
case, not the edge case.

So when the client comes back and asks "where was I?", something has to answer. Whatever is
chosen here also decides how `complete` validates, how the reaper reasons about abandoned
transfers, and whether a resumed upload can be trusted at all.

There is a second, sharper fact that constrains the answer: **`CompleteMultipartUpload` is
not idempotent.** A second call returns `NoSuchUpload`, which is indistinguishable from
"this upload never existed". A retry therefore cannot be used to discover what happened.

## Decision

**The provider is the single source of truth for upload progress. We store the _plan_; we
never store observations.**

Concretely:

1. `IStorageProvider.listParts(key, uploadId)` is on the port, and the resume endpoint
   answers from it. There is no `upload_parts` table.
2. The session row stores only what we decided before any byte moved — `uploadId`,
   `partSize`, `partCount`, `expiresAt`, `storageKey` — plus a lifecycle status.
3. Because `Complete` is not idempotent, the session is claimed into a **`COMPLETING`**
   state with a conditional UPDATE _before_ the provider call. That claim is the mutex: one
   caller reaches the provider, everyone else gets a 409.
4. A session found stale in `COMPLETING` is resolved by asking
   **`objectExists(key)`** — not by retrying the assemble, which cannot answer the question.

```ts
// resume: what the provider holds, not what we think we sent
const stored = await this.storage.listParts(key, uploadId);
// complete: claim first, provider second
const claimed = await this.media.transition(id, 'COMPLETING', from, {});
if (!claimed) throw new IllegalUploadTransitionException(from, 'complet');
await this.storage.completeMultipartUpload(key, uploadId, stored);
```

## Alternatives considered

### 1. A `upload_parts` table, written when the client reports a part

The obvious relational answer, and the one that reads as "more rigorous". Rejected: it is a
**dual write against a fact only the provider observes**, and the writer is a browser that
is allowed to crash. The table and reality diverge exactly when a client dies mid-PUT —
which is precisely the moment the rows existed to serve. It also adds a write per part:
1250 extra round trips on a 10 GB upload, to store information we can fetch in one call.

### 2. The client sends its ETags back at complete time

What the AWS SDK's own high-level uploader does, so it has real pedigree. Rejected because
it makes the **client the authority**, and a client that lost its tab has no list to send.
It would mean a browser crash is unrecoverable while a network blip is recoverable, which is
exactly backwards — the crash is the case the whole feature exists for. `ListParts` costs one
call and works for a client that knows nothing but its session id.

### 3. Transition straight to `COMPLETED`, no `COMPLETING` state

Simpler, and it was the first implementation. It **failed the ten-concurrent-completes
integration test**: all ten calls reached `CompleteMultipartUpload`, one succeeded and nine
received `NoSuchUpload`, which surfaced as nine 500s for an upload that had actually worked.
The provider call has to happen behind a claim, and a claim needs a state to claim into.

### 4. Recover any `COMPLETING` session on sight

The first version of the recovery path. It **failed the same test in the opposite
direction**: concurrent retries saw `COMPLETING`, found no object yet because the winner was
still inside the provider call, and released the winner's claim — after which the winner's
own commit found the session moved and returned 409. Zero successes out of ten. Recovery is
now gated behind a two-minute grace period measured from `updatedAt`; a fresh `COMPLETING`
gets a 409 and is left strictly untouched.

## Consequences

**Good**

- A client that knows only its session id can drive full recovery. Nothing is unrecoverable
  short of losing the id.
- **Resume and progress are the same endpoint**, so the recovery path is exercised on every
  upload rather than only after a crash — no code path that first runs in production.
- No dual write, so there is no drift to reconcile and no reconciliation job to write.
- The state machine's guarantees are enforced by conditional UPDATEs, so they hold under
  concurrency rather than under review.

**Bad, and accepted**

- **One `ListParts` call per resume and per complete.** Cheap, but it is a network call on
  the request path, and a provider outage makes resume unavailable rather than degraded.
- **`listParts` and `objectExists` are now on the port**, which narrows the field of
  backends that can implement it. Both are S3 API standards that MinIO implements, so
  CLAUDE.md §1 L holds — but a backend without them could not be adapted, it would need the
  interface split.
- **A crashed assemble is unavailable for up to two minutes** before recovery will touch it.
  Deliberate: the alternative broke the concurrent case, and two minutes is invisible next to
  the transfer that preceded it.
- A `COMPLETING` session is not reapable, so a provider that never answers leaves a row the
  reaper skips. It is released on the client's next attempt; if the client never returns,
  the parts are collected by the bucket's own multipart lifecycle rule.

## Notes

Both wrong orderings in §3 and §4 were caught by the **ten-concurrent-completes integration
test**, not by review. That test is the evidence for this ADR and is why it is listed in
`BUILD_PLAN.md` §6.2 as an interview artifact.
