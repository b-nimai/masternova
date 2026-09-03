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

## 4. Authoring: draft → reviewed → published

The one flow in the product with a **human in the middle**, and the one where the same
request is made twice from two different tabs.

```mermaid
sequenceDiagram
  autonumber
  participant I as Instructor (web)
  participant API as API · catalog
  participant DB as Postgres
  participant W as Worker · outbox relay
  participant S as Search index (1.13)
  participant M as Mail (1.3)

  I->>API: POST /curriculum {expectedVersion, command}
  API->>DB: BEGIN · claim version (UPDATE … WHERE version = ?)
  Note over API,DB: 0 rows ⇒ 409. The same statement takes the row lock.
  API->>DB: apply command · refresh rollups
  API->>DB: INSERT CourseEdit {command, inverse} · INSERT outbox curriculum-changed
  API->>DB: COMMIT
  API-->>I: 200 {version+1, sections}

  I->>API: POST /submit
  API->>API: publish gate over course + curriculum
  API->>DB: status = IN_REVIEW · outbox catalog.course.submitted
  API-->>I: 200

  Note over API: a reviewer looks at it — the only human step in the system

  participant R as Reviewer (ADMIN)
  R->>API: POST /publish
  API->>API: publish gate re-runs (it may have been edited while queued)
  API->>DB: status = PUBLISHED · publishedAt stamped once · outbox catalog.course.published
  API->>DB: COMMIT
  W->>DB: claim pending outbox rows
  W->>S: index the course
  W->>M: "your course is live" to the instructor
```

**What is worth noticing.**

- **The gate runs twice** — on submission and again on approval. A course can be edited
  while it sits in the queue, so approving what a reviewer saw is not the same as publishing
  what it became.
- **`catalog.course.curriculum-changed` is one event for nine kinds of edit.** The search
  indexer needs exactly one message meaning "reindex this"; a per-edit vocabulary would make
  adding an edit type a cross-context change.
- **The version claim is the first statement and it is also the lock**, which is what makes
  two tabs a 409 instead of a lost update. [ADR-0016](../adr/0016-optimistic-concurrency-for-authoring.md).
- **Nothing downstream is awaited.** Indexing and the email are owed, not part of the
  request — same shape as every other flow here.

---

## 5. Resumable upload → asset ready

The only flow in this document where **the data does not pass through the API at all**.

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as API
  participant S as Object storage
  participant D as Postgres
  participant W as Worker (1.7)

  B->>A: POST /media/uploads
  A->>S: CreateMultipartUpload
  A->>D: Asset(PENDING) + UploadSession(CREATED)
  A-->>B: signed URLs for the first 100 parts

  loop parts — no API involvement
    B->>S: PUT part n
  end

  Note over B: laptop lid closes at part 340

  B->>A: GET /media/uploads/:id
  A->>S: ListParts
  A-->>B: uploadedParts 1..339 + fresh URLs for the gap

  B->>A: POST /media/uploads/:id/complete
  A->>D: UPLOADING -> COMPLETING (conditional claim)
  A->>S: CompleteMultipartUpload
  A->>D: BEGIN · -> COMPLETED · Asset READY · outbox media.asset.ready · COMMIT
  A-->>B: 200 READY
  D-->>W: relay delivers media.asset.ready
  W->>W: probe → transcode → package (task 1.7)
```

**What is different about this flow.** Everywhere else in this document the API is the thing
that observes the change and then records it. Here the change happens between two systems
the API is not part of, so it cannot observe anything — it can only **ask the provider**. That
inverts the usual rule: our database holds the plan and the lifecycle, and object storage
holds the facts. See [ADR-0017](../adr/0017-provider-truth-for-upload-progress.md).

**What is the same.** The last step is identical to every other flow here — the state change
and the outbox row commit in one transaction, and the pipeline that reacts is a consumer the
producer has never heard of.

## 6. Upload → playable

The longest flow in the system, and the only one where a **human waits with a progress bar**.

```mermaid
sequenceDiagram
  participant A as API
  participant O as Outbox relay
  participant Q as BullMQ
  participant W as Worker fleet
  participant S as Object storage
  participant B as Browser (wizard)

  A->>A: upload completes (flow 5) - outbox media.asset.ready
  O->>Q: add probe, jobId = media_probe_<assetId>
  Q->>W: probe - ffprobe over a presigned URL
  W->>Q: flow(parent=package, children=[rungs..., poster, sprite])

  par one job per rung, across the fleet
    Q->>W: transcode(rung)
    W->>S: segments, then the variant playlist
  end

  Q->>W: package (runs only once every child finished)
  W->>S: master.m3u8
  W->>W: pipeline=READY + outbox media.asset.playable (one transaction)

  loop while RUNNING
    B->>A: GET /media/assets/:id/pipeline/stream (SSE)
    A-->>B: {stage, percent}
  end
```

**What is different about this flow.** Everywhere else in this document the work finishes
inside a request. Here it takes minutes, on a machine the requester never touches, and the
only thing connecting them is a ratcheted integer in Postgres that the SSE stream polls. The
progress bar is a _projection_ of the DAG, not a channel into it — which is why the worker
collapses five jobs into one percentage rather than the client reassembling them.

**What is the same.** The last step: the state change and the outbox row commit together,
and the pipeline announces its result to consumers it has never heard of.

## 7. The shape all of these share

1. **State and its consequences commit together**, or neither does.
2. **The request returns as soon as the state is durable.** Consequences are owed, not awaited.
3. **Every consequence is idempotent in its own right.** Delivery is at-least-once; effects
   are exactly-once because each handler has a dedupe key it owns — `ProcessedEvent` for the
   handler, `(eventId, template, recipient)` for a send.
4. **Producers do not know their consumers.** Adding one is additive; nothing upstream changes.
