# ADR-0019 — A short-lived signed playback token, not the session, for media URLs

**Status:** accepted · **Date:** 2026-09-03 · **Task:** 1.8

## Context

`EntitlementGuard` protects the API route. It does not protect what the route hands back: a
URL to an HLS master playlist and the few hundred `.ts` segments it names. The browser
fetches those directly from object storage or a CDN, so:

- a `<video>` element sends no `Authorization` header, and
- on a cross-origin CDN it sends no cookie either.

Whatever authorizes that fetch has to travel **in the URL**, which is the worst place to put
a credential: it lands in browser history, in `Referer` headers, in CDN access logs, and in
whatever chat window someone pastes it into.

## Decision

The grant route returns a **5-minute HMAC-SHA256 token** over a canonical string binding
`userId | lectureId | assetId | expiresAt | ip`. The manifest route is `@Public()` and takes
the token as its only credential.

## Why

**Short-lived, so a leaked URL is worthless.** Five minutes is longer than any player needs
to start a stream and shorter than the time it takes to share a link and have someone use
it. The presigned object URL it buys is capped at the token's own remaining lifetime, so no
artifact of the exchange outlives the grant.

**Bound to one lecture, not to a course or a session.** A stolen token opens exactly the
lecture it was minted for.

**Bound to the caller's address, in production.** Optional and off in development, where a
laptop, a container and a proxy present three different addresses for one user. Mobile
networks re-NAT mid-session, which the five-minute lifetime bounds to one re-issue rather
than a broken stream. A token minted while binding was off keeps working when the flag is
switched on, so a rollout does not break every player mid-lecture.

**Not a JWT.** The claims are five fixed fields. A JWT would add a library, a header nobody
reads, and a negotiable `alg` field that has produced the two best-known authentication
bypasses in the format's history. A versioned HMAC over a canonical string is smaller, has
no algorithm to confuse, and is auditable at a glance.

**Its own secret, not `JWT_ACCESS_SECRET`.** Different blast radius: a leaked playback secret
mints five-minute grants for one lecture; a leaked access secret mints sessions. Rotating one
must not force rotating the other.

## Consequences

- The entitlement chain is **not** re-run on the manifest route. It ran at most five minutes
  ago, and re-running it would put three reads on the path a player hits for every quality
  switch.
- **The revocation window is five minutes, and the two windows are sequential rather than
  parallel.** A refund drops the cache key as it commits (ADR-0018), so the next grant is
  denied and a refunded learner finishes at most one token's worth of video. The cache TTL
  and the token TTL only _compose_ — ten minutes — if the invalidation itself was lost, which
  requires a Redis failover between the `DEL` and the next read. Worth stating exactly:
  an earlier draft of this ADR claimed "five minutes by either route", which quietly
  understated the worst case by half.
- The token appears in a query string, and query strings are logged. That is why it expires
  in five minutes and is bound to an address; it is not a secret worth protecting beyond
  that window.

## What this does NOT cover — layer 3

The presigned URL protects **the master playlist**. It does not protect the segments the
playlist names: those are separate objects, fetched directly by the player, and today they
are reachable by anyone who can read the manifest and construct a key.

Closing that is the CloudFront signed cookie, and it needs a distribution and a key pair that
do not exist until Phase 2. The seam is `PlaybackService.manifest`: the presign call becomes
a distribution path plus a `CloudFront-Signature` cookie scoped to `video/{assetId}/*`, and
the segment fetches start being signed by the edge.

Written down rather than papered over. A security layer everyone believes is present is worse
than one everyone knows is missing.
