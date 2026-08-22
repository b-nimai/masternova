# Masternova — How to explain this project

## The one sentence (memorize this)

> "It's an EdTech platform — but the real project is the backend problem underneath it:
> **how do you sell access to a video, and then make sure only the people who paid can watch it**
> — without ever double-charging anyone, and without melting under load?"

Three sub-problems fall straight out of that sentence, and they are the whole project:
1. Get the video ready to stream — **ingest + transcode pipeline**
2. Take the money exactly once — **checkout, idempotency, outbox**
3. Decide who's allowed to watch — **entitlement engine**

Never open with a feature list. Features are the *consequence*, not the pitch.

---

## 30-second version (recruiter / HR screen)

"I built a production-grade online course platform — learners browse courses, buy them, and
stream video; instructors upload content and get paid out. The interesting part isn't the CRUD,
it's the infrastructure: an async video transcoding pipeline, a payment flow that's safe against
duplicate webhooks, and an authorization layer that enforces paid access all the way down to the
CDN. It runs on AWS, deployed by Terraform and GitHub Actions, with OpenTelemetry tracing and
SLO-based alerting."

---

## 5-minute version (engineering interview)

### 0:00 – 0:30 — Frame the problem
"Masternova is an online course platform — the Udemy shape. Learners browse, buy, and stream
courses; instructors author them and earn a revenue share.

I picked it deliberately, because underneath a simple-looking product there are three genuinely
hard backend problems: getting video ready to stream, taking money exactly once, and deciding
who's allowed to watch. Let me walk through the architecture, then those three."

### 0:30 – 1:15 — Architecture in one breath
"It's a **modular monolith plus a separate worker fleet**, on Postgres, Redis and S3.

The API is NestJS with hard module boundaries — identity, catalog, media, commerce, enrollment,
engagement, notifications. The workers are a separate deployable because they have a completely
different resource profile: ffmpeg transcoding is CPU-bound and bursty, HTTP is IO-bound and
steady. So they scale independently.

I chose a monolith on purpose. At this traffic, microservices would buy me deployment complexity
and distributed transactions in exchange for nothing. I've written up exactly where I'd split it
when that stops being true — media first, then commerce."

> This sentence alone signals seniority: you *chose*, you didn't default.

### 1:15 – 2:00 — Problem 1: the video pipeline
"An instructor uploads a 2 GB file from the browser. That goes **direct to S3 as a presigned
multipart upload** — it never touches my API — and it's resumable, so a dropped connection
resumes from the part it left off.

Completion enqueues a **job DAG in BullMQ**: probe the file, fan out to transcode a 240/480/720/
1080 ladder, package it as HLS, generate the thumbnail sprite, transcribe it, and embed the
transcript for semantic search.

Every worker is **idempotent** — deterministic output keys and upsert-on-conflict — because jobs
*will* retry. My test for this is killing a worker mid-transcode with SIGKILL: the job re-runs and
you get zero duplicate renditions and no orphaned S3 objects. Anything that exhausts its retries
lands in a **dead-letter queue** with a replay endpoint."

### 2:00 – 2:45 — Problem 2: taking money exactly once
"Checkout is an **explicit state machine**: cart → order created → payment pending → paid →
enrolled, with refund branches that revoke access.

Two things make it safe. First, **idempotency keys** — the client sends one, I store the request
hash and the response, and a replay returns the stored response instead of charging again.
Second, the payment webhook is the hard part: it can arrive twice, out of order, or *before* the
user's redirect. So I dedupe on the provider's event ID and the state machine only ever moves
forward.

Then, to actually enroll the user and send the receipt, I use a **transactional outbox** — the
order state change and the outbox rows commit in one Postgres transaction, and a relay worker
publishes them. That gives me exactly-once *effects* without a distributed transaction.

The test I'm proudest of: fire the same webhook 50 times concurrently, and you get exactly one
enrollment, one invoice, one email."

### 2:45 – 3:15 — Problem 3: who's allowed to watch
"Authorization here isn't a boolean. 'Can this user play this lecture?' depends on whether they
purchased it, whether the refund window has passed, whether it's a free preview lecture, whether
they're the instructor, whether the course is even published.

So it's an **attribute-based policy engine** — a chain of policies each returning allow, deny or
abstain, with explicit deny winning. The decision is cached in Redis and invalidated by order and
publish events.

And it's enforced at **three layers**: the API guard, then a short-lived signed playback token,
then CloudFront signed cookies on the HLS path. That last one matters — without it, someone
shares a manifest URL and your paid content is free. A leaked URL from my system is dead in five
minutes."

### 3:15 – 4:15 — The infrastructure story
"Everything is containerized — multi-stage builds, non-root, and `docker compose up` gives you
the entire stack locally including Postgres, Redis, MinIO, Typesense and the Grafana stack.

Infra is **Terraform** on AWS: ECS Fargate, RDS Multi-AZ with point-in-time recovery,
ElastiCache, S3 with lifecycle rules, CloudFront. CI is GitHub Actions authenticating to AWS via
**OIDC — there are no long-lived AWS keys anywhere in the repo**. The pipeline runs lint,
typecheck, unit tests, integration tests against real Postgres and Redis via Testcontainers,
builds and Trivy-scans the image, runs migrations, does a blue/green deploy, smoke-tests it, and
rolls back automatically if that fails.

Migrations are **expand-contract**, so a deploy is zero-downtime and safely rollback-able.

The scaling detail I like most: the **worker fleet autoscales on queue depth**, not CPU — queue
depth is the signal that actually correlates with 'learners are waiting'. Workers run on spot with
graceful SIGTERM draining, so a reclaimed instance returns its job to the queue instead of
losing it, and the fleet scales to zero when nobody's uploading.

For observability I run OpenTelemetry across the API and the workers, and I **propagate trace
context through the job payload** — so one trace spans checkout → webhook → outbox relay → email
sent, across a queue boundary. On top of that: RED metrics for the API, USE for workers, business
metrics like orders per minute and video start time, and **SLOs with multi-window burn-rate
alerts** — 99.9% availability, p95 under 300 ms, video start under two seconds — each alert
wired to a runbook."

### 4:15 – 5:00 — Numbers, tradeoffs, and the close
"I load-tested it with k6 at 1,000 concurrent learners and it held p95 under 300 ms. [Insert your
real tuning story here — e.g. 'the course listing was 400 ms until I found a sequential scan;
the right composite index took it to 40.']

One thing I'd call out as a real tradeoff: watch-progress heartbeats. At 100k learners that's
roughly 10,000 writes a second, which Postgres would not enjoy. So heartbeats go into a Redis
write-back buffer and flush in batches. That means I can lose up to 30 seconds of progress on a
Redis failure — and I decided that's acceptable for a progress bar. It would not be acceptable
for the payment path, which is why that one is fully transactional.

If you want, I can go deeper on any of the three — the pipeline, the payment consistency model,
or the authorization layer."

> Always end by offering the choice. It hands them a doorway and makes you look like you have
> more depth than time.

---

## Bait these follow-ups (you want to be asked)

| If they ask… | You have… |
| --- | --- |
| "Why not microservices?" | the ADR + the 10x split plan, in order, with breaking points named |
| "What if the webhook fires twice?" | dedupe + state machine + outbox + the 50-replay test |
| "How do you stop someone sharing the video URL?" | three-layer enforcement, 5-minute signed cookies |
| "How do you scale the workers?" | queue depth, not CPU + spot + graceful drain + scale-to-zero |
| "What breaks first at 10x?" | entitlement cache invalidation fan-out, and ledger contention |
| "How do you deploy without downtime?" | expand-contract migrations + blue/green + auto-rollback |
| "How do you know it's healthy?" | SLOs, error budgets, burn-rate alerts, runbook per alert |

## Never say

- "I used JWT for auth" → say refresh-token rotation with reuse detection.
- "I added Redis for caching" → say what you cache, and how you invalidate it.
- "It's scalable" → give a number from a load test, or say nothing.
- A feature list. Lead with the problem, always.
