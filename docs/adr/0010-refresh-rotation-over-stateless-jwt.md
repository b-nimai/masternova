# ADR-0010 — Refresh rotation with reuse detection, over a stateless JWT pair

**Status:** accepted · **Date:** 2026-08-22 · **Deciders:** Nimai
**Supersedes:** the `@fastify/secure-session` cookie shipped in Phase 0.

## Context

Authentication runs on every request, so answering "who is this" has to be cheap. It also
has to be **withdrawable**: signing out one device, and resetting a password because you
believe you are compromised, must actually end sessions.

Those requirements conflict. A self-contained signed token needs no database read and cannot
be taken back. An opaque token backed by a row is revocable and costs a lookup per request.

Phase 0 inherited `@fastify/secure-session` from Loom Lite AI — an encrypted, server-
stateless cookie. It was fine for a demo and wrong here: nothing on the server recorded that
a session existed, so signing out on one device left every other cookie valid until it
expired. There was no revocation to speak of.

A long-lived refresh token adds its own problem. It is a bearer credential with a 30-day
life, and if it leaks, nothing in the protocol tells you it leaked.

## Decision

**Split the credential, and rotate the long half.**

1. **Access token — signed JWT, 15 minutes, verified with no database read.** Carries
   `{ sub, role, sid }`. The TTL _is_ the revocation window: revoking a session stops the
   next refresh immediately but leaves the current access token working for up to 15
   minutes. That window is the price of keeping a lookup off the hot path.

2. **Refresh token — opaque, 256-bit random, stored SHA-256 hashed, 30 days.** It carries no
   claims because it grants nothing on its own; it is a lookup key into a `Session` row we
   control, which is exactly what makes revocation possible. Its cookie is scoped to
   `/api/auth/refresh`, so the long-lived credential is never sent anywhere else.

3. **Rotation with reuse detection.** Every refresh mints a new token and marks the old one
   `usedAt`. Used rows are **kept, never deleted** — you cannot detect the replay of a row
   you removed. A spent token presented again means the chain leaked, because the honest
   client has already moved on to its replacement. We cannot tell attacker from victim, so
   the entire session is revoked and both are forced to sign in again.

## Consequences

**Positive.** Revocation is real: per-device sign-out, sign-out-everywhere, and password
reset all end sessions immediately for refresh purposes. A leaked refresh chain is
self-detecting rather than silent — the theft announces itself the moment either party
refreshes. Authorization stays a signature check with no I/O.

**Negative.** A revoked session keeps working for up to 15 minutes on its current access
token. Two tables and a rotation transaction on a path that a stateless design would not
have had at all. The `RefreshToken` table grows monotonically and needs an expiry sweep.
And a legitimate user _can_ be logged out by the false-positive case below.

**Accepted risk.** Two tabs refreshing simultaneously can both present the same token, and
the second one trips reuse detection and kills a session nobody attacked. The cost is one
re-login; the alternative — a grace window in which a spent token still works — is exactly
the hole the mechanism exists to close. If it proves noisy in practice, the fix is a short
same-session grace period keyed on the replacement token, not disabling detection.

**Follow-on.** Reuse detection is only half of a security control if nobody is told. The
security-alert email is owned by `notification` (task 1.3), driven off an outbox event, so
identity still sends no mail.
