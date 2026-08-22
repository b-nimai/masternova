# Data flows — end to end

**Status:** incremental · **Last updated:** 2026-08-22
Covers the flows that exist today. `upload → playable`, `checkout → enrolled` and `playback`
are added as tasks 1.6, 1.7 and 1.9 land — not sketched in advance.

---

## 1. Signup → verified → welcomed

The first flow that crosses a bounded context, and the one every later flow copies.

```mermaid
sequenceDiagram
    autonumber
    actor U as Learner
    participant W as web
    participant A as api · identity
    participant P as postgres
    participant K as worker · outbox relay
    participant N as worker · notification
    participant M as SMTP

    U->>W: submit signup
    W->>A: POST /api/auth/register

    rect rgb(238, 242, 255)
        Note over A,P: ONE transaction
        A->>P: INSERT User (argon2id hash)
        A->>P: INSERT VerificationToken (SHA-256 of the token)
        A->>P: INSERT OutboxMessage identity.user.registered
        A->>P: INSERT OutboxMessage identity.email.verification_requested
    end

    A-->>U: 201 — signup is complete right here
    Note over A,M: nothing has touched SMTP yet, and nothing will on this request

    loop every 1s
        K->>P: claim due messages (FOR UPDATE SKIP LOCKED)
    end
    K->>N: dispatch(identity.email.verification_requested)
    N->>P: INSERT EmailDelivery (eventId, template, recipient) ← claim
    N->>M: send "Confirm your email address"
    M-->>N: provider message id
    N->>P: EmailDelivery = SENT · OutboxMessage = PUBLISHED

    U->>A: POST /api/auth/verify-email { token }
    rect rgb(238, 242, 255)
        Note over A,P: ONE transaction
        A->>P: mark token used (single-use under a double click)
        A->>P: User.emailVerified = now
        A->>P: INSERT OutboxMessage identity.email.verified
    end
    K->>N: dispatch(identity.email.verified)
    N->>M: send the welcome (PRODUCT_NEWS — carries an unsubscribe link)
```

**What the diagram is arguing.** The 201 comes back before any email exists. A mail outage
delays the verification email; it cannot fail the signup, and there is no state in which an
account exists with no email owed — the outbox rows commit with the user row or not at all.

**The failure path.** If SMTP is down, the delivery row goes `FAILED`, the handler rethrows,
the outbox message stays `PENDING` with `availableAt` pushed forward, and the relay tries
again with exponential backoff. After eight attempts it parks as `DEAD` — retained, not
deleted, so it can be replayed once the cause is fixed.

---

## 2. Refresh rotation, reuse detection, and the alert

The security flow, and the one place two contexts cooperate on an incident.

```mermaid
sequenceDiagram
    autonumber
    actor V as Victim
    actor X as Attacker
    participant A as api · identity
    participant P as postgres
    participant K as worker · outbox relay
    participant N as worker · notification

    Note over X: holds a stolen refresh token R1
    V->>A: POST /api/auth/refresh (R1)
    A->>P: R1.usedAt = now · issue R2
    A-->>V: new access + R2

    X->>A: POST /api/auth/refresh (R1)
    A->>P: R1.usedAt is not null → the chain leaked
    rect rgb(254, 242, 242)
        Note over A,P: ONE transaction
        A->>P: revoke the session (REUSE_DETECTED)
        A->>P: INSERT OutboxMessage identity.session.reuse_detected
    end
    A-->>X: 401
    V->>A: POST /api/auth/refresh (R2)
    A-->>V: 401 — the session is gone

    K->>N: dispatch(identity.session.reuse_detected)
    N->>V: "We signed you out to protect your account"
```

Revocation and the alert commit together, so there is no state in which a session was killed
for a security reason nobody will ever hear about. Both parties are logged out: at the
moment of detection there is no way to tell attacker from victim, and the safe failure is to
make the human sign in again with something the attacker does not have.

---

## 3. Bounce → suppression

The only flow that starts outside the system.

```mermaid
sequenceDiagram
    autonumber
    participant M as Mail provider
    participant A as api · notification
    participant P as postgres
    participant N as worker · notification

    M->>A: POST /api/webhooks/mail/resend (email.bounced)
    A->>A: verify HMAC over the raw bytes (constant-time)
    A->>P: EmailDelivery(providerMessageId) = BOUNCED
    A->>P: UPSERT EmailSuppression(address, HARD_BOUNCE)
    A-->>M: 200 — always, once the signature verifies

    Note over N,P: every later send, of every category
    N->>P: suppressionFor(address)
    P-->>N: HARD_BOUNCE
    N->>P: EmailDelivery = SUPPRESSED (recorded, not silently dropped)
```

A hard bounce suppresses the address ahead of every preference and every mandatory
category. The reasoning is not politeness: continuing to send to dead mailboxes is what gets
a sending domain blocklisted, and at that point _nobody_ receives receipts.

Answering 2xx for event types we do not model is deliberate. A 500 on an "opened" event has
the provider redeliver it every few minutes until it gives up on the endpoint entirely,
taking the bounces we do care about with it.

---

## 4. The shape all of these share

1. **State and its consequences commit together**, or neither does.
2. **The request returns as soon as the state is durable.** Consequences are owed, not awaited.
3. **Every consequence is idempotent in its own right.** Delivery is at-least-once; effects
   are exactly-once because each handler has a dedupe key it owns — `ProcessedEvent` for the
   handler, `(eventId, template, recipient)` for a send.
4. **Producers do not know their consumers.** Adding one is additive; nothing upstream changes.
