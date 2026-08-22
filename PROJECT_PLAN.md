# Project Plan: **Masternova** — Production-Grade EdTech Platform

> Portfolio project to demonstrate **Backend + DevOps** depth (with credible frontend) for a
> switch at the **1.5–2 YoE SDE** level. Replaces _Loom Lite AI_. Built from an existing
> full Figma, so UI is a solved problem and all effort goes into engineering depth.

---

## 1. Why this project beats Loom Lite AI

| Axis                 | Loom Lite AI   | Masternova                                                                     |
| -------------------- | -------------- | ------------------------------------------------------------------------------ |
| Money flows          | none           | cart, coupons, orders, refunds, **instructor payouts ledger**                  |
| Access control       | owner/public   | **entitlement engine**: purchased / refunded / preview / instructor / admin    |
| Actors               | one            | **two-sided** (learner + instructor + admin) → real RBAC + ABAC                |
| Write-heavy path     | none           | **watch-progress heartbeats** (the scale conversation)                         |
| Async pipeline       | transcode + AI | same pipeline, _plus_ it now gates paid content                                |
| Consistency problems | few            | order↔enrollment↔email **exactly-once**, rating aggregation, search index sync |
| Design assets        | none           | **complete Figma** — you ship a product, not a demo                            |

You inherit from Loom: pnpm monorepo, NestJS+Fastify, Prisma, BullMQ worker, MinIO,
docker-compose, Mailpit. **Reuse all of it.** Week 1 is a rename + reshape, not a rebuild.

---

## 2. Product scope (from the Figma)

**Learner:** signup · login · forgot password · reset link email · set new password · home ·
course list (search/filter) · course detail · cart · checkout · about · contact · profile ·
edit profile · my enrolled courses · course video player · add-review modal
**Instructor:** dashboard · all-courses list · **multistep course creation wizard**
**System:** transactional email templates

Every screen stays. The point is that behind each one sits a real engineering problem.

---

## 3. Architecture — modular monolith + worker fleet

Deliberate choice, and **the justification is an interview answer**: at this traffic,
microservices buy you deployment complexity and distributed-transaction pain for nothing.
So: one deployable API with hard module boundaries, plus a separately-scaled worker fleet
(different resource profile: CPU-bound ffmpeg vs IO-bound HTTP). Then a written
"how I'd split this at 10x" section (§10) proves you _chose_ rather than defaulted.

```
                          CloudFront (CDN)
                     ┌─────────┴─────────┐
             static + HLS segments   ALB
                     │            ┌──────┴──────┐
                     │            │             │
                 S3 buckets   Next.js       NestJS API  ──► PostgreSQL 16 + pgvector
                (masters,     (SSR/ISR)     (Fastify)   ──► Redis (cache + BullMQ + rate limit)
                 hls, assets)                  │        ──► Typesense (search)
                                               │ enqueue
                                               ▼
                                        Redis / BullMQ
                                               │
                                    ┌──────────┴──────────┐
                                    │   Worker fleet      │  autoscaled on QUEUE DEPTH
                                    │  transcode (ffmpeg) │
                                    │  package HLS        │
                                    │  thumbnails/sprite  │
                                    │  transcribe (AI)    │
                                    │  embed → pgvector   │
                                    │  outbox-relay       │──► email provider
                                    │  search-indexer     │──► Typesense
                                    └─────────────────────┘
```

### Bounded contexts (NestJS modules, own folder + own Prisma models + no cross-imports except via public service interface)

| Context        | Owns                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `identity`     | users, credentials, sessions/devices, refresh rotation, RBAC roles       |
| `catalog`      | courses, sections, lectures, categories, pricing, publish state          |
| `media`        | upload sessions, assets, transcode jobs, HLS renditions, playback tokens |
| `commerce`     | cart, coupons, orders, payments, invoices, refunds, ledger               |
| `enrollment`   | entitlements, progress, certificates                                     |
| `engagement`   | reviews, ratings aggregate, Q&A, contact messages                        |
| `notification` | templates, outbox, delivery log, bounces, unsubscribe                    |
| `analytics`    | event ingest, rollups, instructor revenue dashboards                     |

---

## 4. The eight problems that make this senior-level

These are your interview weapons. Each gets its own LLD doc in `docs/lld/`.

### 4.1 Entitlement / authorization engine ⭐ crown jewel

"Can user U play lecture L right now?" — purchased, refund window elapsed, free preview
lecture, coupon-granted access, instructor's own course, admin, or course unpublished.

- **ABAC policy engine**: `Policy[]` evaluated by a chain, each returning
  `ALLOW | DENY | ABSTAIN`; explicit DENY wins. Patterns: **Strategy + Chain of
  Responsibility + Specification**.
- Decision cached in Redis, keyed `ent:{userId}:{courseId}`, invalidated on
  order/refund/publish events.
- Enforced at **three layers**: API guard → short-lived signed playback token (JWT, 5 min,
  bound to userId+lectureId+IP) → CloudFront signed cookie on the HLS path. A leaked
  manifest URL is useless.

### 4.2 Checkout: order state machine + idempotency + outbox

```
CART → ORDER_CREATED → PAYMENT_PENDING → PAID → ENROLLED
                    ↘ FAILED   ↘ EXPIRED       ↘ REFUNDED → ENTITLEMENT_REVOKED
```

- `Idempotency-Key` header + `idempotency_records` table (key, request hash, response,
  expiry) → same key replays the stored response, never re-charges.
- Webhooks: verify signature, **dedupe on provider event id**, handle out-of-order arrival
  (state machine only moves forward), handle webhook-before-redirect.
- **Transactional outbox**: order state change + outbox rows committed in ONE transaction;
  a relay worker publishes → enroll, invoice, email. Gives you exactly-once _effects_
  without a distributed transaction.
- Test that proves it: fire the same webhook 50× concurrently → exactly one enrollment,
  one invoice, one email.

### 4.3 Instructor payouts — double-entry ledger

Every rupee move is two rows (debit/credit) that must sum to zero. Platform fee split,
tax withholding, refund reversal, payout batches. Immutable append-only, balances derived.
Rare in portfolios, instantly credible in a backend interview.

### 4.4 Video ingest & transcode pipeline

- Browser → **presigned S3 multipart upload**, resumable (upload session table tracks
  parts; kill the network, resume from part N).
- Completion → job DAG in BullMQ: `probe → transcode(240/480/720/1080 fanout) →
package HLS → sprite+poster → transcribe → embed`.
- **Idempotent workers** (deterministic output keys, `INSERT ... ON CONFLICT`), exponential
  backoff, **DLQ** + replay endpoint, per-job progress streamed to the wizard via SSE.
- Failure drill for the README: SIGKILL a worker mid-transcode → job re-runs → no duplicate
  renditions, no orphaned S3 objects (reconciliation sweeper).

### 4.5 Watch-progress at write scale

100k learners × a heartbeat per 10s = ~10k writes/s. Naïve `UPDATE progress` melts Postgres.

- Heartbeat → Redis hash (write-back buffer) → flushed in batches every 30s / on pause /
  on `beforeunload` via `sendBeacon`.
- Durable event stream for analytics (append-only), rollups for "% complete".
- Discuss: at-least-once beats, monotonic `maxPositionSeconds`, and why last-write-wins is
  acceptable _here_ (and where it wouldn't be).

### 4.6 Multistep course creation wizard (server-side)

- Draft is a **state machine** (`DRAFT → IN_REVIEW → PUBLISHED → ARCHIVED`) with per-step
  validation and a publish gate ("every section has ≥1 lecture, all media READY, price set").
- Autosave with **optimistic concurrency** (`version` column, 409 on conflict) — two tabs
  open is a real bug you handle.
- Patterns: **Builder** for course assembly, **State** for transitions, **Command** for
  undoable step edits.

### 4.7 Search & discovery

- Typesense (typo-tolerant, faceted: level/price/rating/category/language) + **pgvector**
  semantic search over descriptions and lecture transcripts.
- Index kept in sync via the **same outbox** — never dual-write. Backfill/reindex CLI.
- Ranking blend: relevance × enrollment × rating × recency, tunable and explained.

### 4.8 Ratings aggregation without table scans

Denormalized `rating_count`, `rating_sum`, and a 1–5 histogram updated **incrementally**
inside the review transaction; edits/deletes apply deltas. Periodic reconciliation job
proves the denormalized value never drifts.

---

## 5. Tech stack

| Layer         | Choice                                                                                | Interview justification                                                 |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| API           | **NestJS 11 + Fastify**                                                               | Modules ≈ Spring Boot; DI, guards, interceptors, filters — LLD-friendly |
| ORM/DB        | **Prisma + PostgreSQL 16 + pgvector**                                                 | One DB for relational + vector; explicit migrations                     |
| Cache/Queue   | **Redis + BullMQ**                                                                    | cache, rate limit, queue, write-back buffer, distributed lock           |
| Search        | **Typesense**                                                                         | typo tolerance + facets without JVM ops overhead                        |
| Object store  | **MinIO (dev) → S3 (prod)**                                                           | zero code change; lifecycle rules for masters                           |
| CDN           | **CloudFront** + signed cookies                                                       | secure paid-video delivery                                              |
| Payments      | **Razorpay** (+ Stripe adapter)                                                       | provider abstraction = Adapter pattern                                  |
| Email         | **React Email + Resend/Brevo**, Mailpit local                                         | your Figma templates become typed components                            |
| Frontend      | **Next.js 15 App Router + Tailwind + shadcn/ui**                                      | ISR on catalog, SSR on detail, client islands for player/wizard         |
| Auth          | argon2id + httpOnly cookies, **refresh rotation w/ reuse detection**, device sessions | security depth, not "I used JWT"                                        |
| Containers    | Docker multi-stage, non-root, distroless runtime                                      | image size numbers in README                                            |
| Orchestration | **ECS Fargate** live; **Helm chart + kind** for K8s talking points                    | cheap to run, full K8s story available                                  |
| IaC           | **Terraform**, remote state S3 + DynamoDB lock                                        | modules, workspaces, plan-in-CI                                         |
| CI/CD         | **GitHub Actions**, OIDC to AWS (no static keys)                                      | reusable workflows, matrix, cache                                       |
| Observability | **OpenTelemetry → Tempo, Prometheus, Grafana, Loki**, Sentry                          | traces that cross the queue boundary                                    |
| Testing       | Jest + **Testcontainers**, Playwright, **k6**                                         | real Postgres/Redis in integration tests                                |

---

## 6. DevOps: what you actually build

**Docker**

- Multi-stage builds (deps → build → runtime), non-root user, `HEALTHCHECK`, tight
  `.dockerignore`, pnpm store cache mounts. Record image sizes before/after (e.g. 1.2 GB → 180 MB).
- `docker-compose.yml` brings up: postgres(pgvector), redis, minio, mailpit, typesense,
  otel-collector, prometheus, grafana, loki, tempo, api, worker, web. **One command, full stack.**

**CI (GitHub Actions)**

```
lint + typecheck ─┐
unit tests        ├─► build image (buildx cache) ─► Trivy scan ─► SBOM (syft)
integration (TC)  │                                   │
e2e (Playwright) ─┘                                   ▼
                                          push ECR ─► terraform plan (PR comment)
                                                   ─► migrate (expand-contract)
                                                   ─► deploy (blue/green)
                                                   ─► smoke test ─► auto-rollback on fail
```

- **OIDC role assumption**, no long-lived AWS keys anywhere. Say this in the interview.
- Branch protection, required checks, conventional commits, semantic-release.

**Terraform (AWS)**
VPC (public/private subnets, NAT), ALB + ACM + Route53, ECS Fargate services (api, worker,
web) with autoscaling, RDS Postgres (Multi-AZ, PITR), ElastiCache Redis, S3 (masters /
hls / public assets with lifecycle → IA → Glacier), CloudFront + OAC + signed cookies,
Secrets Manager, least-privilege IAM per task role, CloudWatch alarms.

**Scaling story**

- API: target-tracking on CPU + ALB RPS.
- **Workers: autoscale on BullMQ queue depth** (custom CloudWatch metric → ECS step scaling;
  KEDA `ScaledObject` in the Helm variant). Scale-to-zero when idle. This is the DevOps
  detail interviewers remember.
- Spot capacity for transcode workers + graceful SIGTERM draining (job returns to queue).

**Reliability**

- Expand-contract migrations (add column → backfill → dual-write → switch → drop), so deploys
  are zero-downtime and rollback-safe.
- Documented **RTO/RPO**, and an actually-executed restore drill (PITR to a scratch instance).
- Runbook per alert, in `docs/runbooks/`.

---

## 7. Observability: SLOs, not just dashboards

- **OTel auto+manual instrumentation** in API and worker; propagate trace context **through
  the BullMQ job payload** so one trace spans `POST /checkout → webhook → outbox relay →
email sent`. Screenshot that trace in the README — it's the single most convincing image
  in the whole project.
- **Metrics**: RED for API (rate/errors/duration), USE for workers, plus business metrics —
  orders/min, checkout conversion, queue depth, transcode p95, video start time, AI cost/day.
- **SLOs** with error budgets and multi-window burn-rate alerts:
  - API availability 99.9%, p95 latency < 300 ms
  - Video start time (click → first frame) < 2 s p95
  - Upload → playable < 5 min p95
- Logs: pino JSON → Loki, `trace_id` correlated, PII redaction.
- Sentry + Web Vitals RUM on the frontend.

---

## 8. Testing & proof

| Level       | Tool                                 | What it proves                                                         |
| ----------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Unit        | Jest                                 | policy engine, state machines, ledger arithmetic                       |
| Integration | **Testcontainers** (real PG + Redis) | repositories, transactions, outbox, idempotency                        |
| Contract    | OpenAPI + schemathesis               | API doesn't drift                                                      |
| E2E         | Playwright                           | signup → buy → watch → review                                          |
| Load        | **k6**                               | 1,000 concurrent learners; publish p50/p95/p99 + a tuning before/after |
| Chaos       | scripted                             | kill worker mid-job · kill DB primary · replay webhooks · fill the DLQ |

---

## 9. Documentation deliverables (this is half the interview score)

```
docs/
  hld/    context + container + component (C4) diagrams, capacity estimation for 100k learners,
          data flow, failure modes, "why modular monolith"
  lld/    entitlement-engine.md · order-state-machine.md · video-pipeline.md ·
          wizard-draft-state.md · ledger.md   (each with class + sequence diagrams)
  adr/    0001-modular-monolith.md · 0002-postgres-pgvector-over-dedicated-vectordb.md ·
          0003-hls-over-progressive-mp4.md · 0004-outbox-over-direct-publish.md ·
          0005-ecs-fargate-over-eks.md · 0006-typesense-over-elasticsearch.md
  api/    OpenAPI spec, error envelope, cursor pagination, versioning, idempotency contract
  db/     ERD, index rationale, one EXPLAIN ANALYZE before/after story
  runbooks/  one per alert
  slo.md  targets, error budgets, burn-rate policy
```

Your `LLD/` folder (SOLID, UML, design patterns) feeds directly into `docs/lld/` — same notes,
now applied to a real system. That's a strong "I studied it and shipped it" narrative.

---

## 10. "How would you scale this to 10x?" — written answer

Split by **rate of change and resource profile**, in this order:

1. **media-service** first (CPU-bound, spot-friendly, independent deploy cadence)
2. **commerce-service** next (compliance boundary, its own DB, saga replaces local transaction)
3. Postgres: read replicas → partition `progress_events` by month → CDC (Debezium) feeding
   search + analytics instead of the outbox relay
4. Redis → cluster mode; move BullMQ to SQS/SNS for durability at that scale
5. Multi-region: CloudFront + S3 CRR for media, single-writer Postgres w/ read replicas per region
6. Where it breaks: entitlement cache invalidation fan-out, and payout ledger contention.

Naming the _breaking points_ is what separates a senior answer from a buzzword answer.

---

## 11. Build plan — the REAL calendar (8 weeks, Aug 24 → Oct 19)

**Reality check (2026-08-22):** the project window closes Oct 19, apply phase starts Oct 20.
At ~14.5 project hours/week that is **~115 hours**. The idealised 12-week plan needs ~175.
So this is the version that actually ships. A finished, deployed, load-tested, documented
8-week project beats a 60%-complete 14-week one — every time, without exception.

### What transfers from Loom Lite AI (you are NOT starting from zero)

| Loom already has                                      | Becomes in Masternova   | Rework                                 |
| ----------------------------------------------------- | ----------------------- | -------------------------------------- |
| pnpm monorepo, NestJS+Fastify, Prisma, Docker compose | same foundation         | rename only                            |
| Passport auth (local + Google), sessions              | `identity` module       | add refresh rotation + reuse detection |
| S3/MinIO storage + presigned uploads                  | `media` upload sessions | add multipart resumability             |
| BullMQ worker + enqueue-on-upload                     | worker fleet            | add the job DAG                        |
| Browser recorder                                      | _(dropped)_             | —                                      |

**Do this as a fork of the Loom repo, not a new one** — you keep the May–July commit history,
so the repo shows six months of sustained work instead of an eight-week sprint.

### Weekly plan

| Wk  | Dates        | Deliverable                                                                                                                                        | Done when                                                                |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Aug 24–30    | Fork + reshape to Masternova; `catalog` schema; course list + detail from Figma; harden auth (refresh rotation, reset flow, React Email templates) | 10k seeded courses, list p95 < 100 ms, all 5 auth screens work           |
| 2   | Aug 31–Sep 6 | Instructor wizard: draft state machine, autosave + optimistic locking, publish gate; resumable multipart upload                                    | Create → leave → resume → publish; 1 GB upload survives a killed network |
| 3   | Sep 7–13     | Transcode pipeline: BullMQ job DAG, ffmpeg ABR ladder → HLS, sprites, idempotent workers, DLQ, SSE progress                                        | SIGKILL mid-job → clean recovery, zero duplicate renditions              |
| 4   | Sep 14–20    | **Entitlement engine** + playback tokens + CloudFront-style signed access; progress heartbeats w/ Redis write-back                                 | Non-enrolled user blocked at API _and_ at the CDN path                   |
| 5   | Sep 21–27    | **Commerce**: cart, checkout, idempotency keys, webhook dedupe, order state machine, outbox → enroll + invoice + email                             | 50 concurrent replays of one webhook → exactly one enrollment            |
| 6   | Sep 28–Oct 4 | Docker multi-stage, GitHub Actions (OIDC), Terraform, **live on AWS**, expand-contract migrations, blue/green                                      | `git push` → prod in < 10 min, zero downtime, one-click rollback         |
| 7   | Oct 5–11     | OTel across API↔queue↔worker, Prom/Grafana/Loki/Tempo, RED+USE+business dashboards, SLOs + burn-rate alerts, runbooks                              | One trace spans checkout → webhook → outbox → email                      |
| 8   | Oct 12–19    | k6 load test, chaos drills, PITR restore drill, perf tuning before/after, HLD/LLD/ADR docs, C4, demo video, README                                 | A stranger reads the README and understands the system in 5 minutes      |

### Cut from scope — designed and documented, NOT built

Reviews + rating aggregation · Typesense/pgvector search · double-entry payout ledger ·
coupons · refunds · the AI/transcription layer · Helm/K8s variant · About/Contact pages.

**This is a feature, not a compromise.** Write each one up in `docs/adr/` or `docs/lld/` as
"designed, deliberately out of scope for v1, here's the design and here's what it would cost."
Being able to say _"I scoped that out on purpose, and here's the design I'd build"_ is a stronger
interview signal than a half-finished implementation of it. Interviewers probe scope judgement.

### If you fall behind — cut in this order

1. Week 8 polish (do a rough README, keep the numbers)
2. Progress heartbeats (Week 4) — keep the entitlement engine, it's the crown jewel
3. Instructor wizard sophistication (Week 2) — a plain form still feeds the pipeline

**Never cut weeks 5, 6 or 7.** Commerce correctness, live deployment, and observability are the
entire reason this project beats a CRUD app. A project that isn't deployed doesn't exist.

---

## 12. Deliberately out of scope

Microservices from day one · Kafka · service mesh · custom DRM · multi-tenancy ·
GraphQL · self-hosted Kubernetes control plane. Each adds config, not signal.
If asked about any of them, §10 is your answer.

---

## 13. Resume lines this project earns

- Designed a modular-monolith EdTech platform (NestJS/Postgres/Redis/S3) serving an
  ABR video pipeline; sustained **1k concurrent learners at p95 < 300 ms** in k6 load tests.
- Built an idempotent, outbox-backed checkout — webhook replays and out-of-order delivery
  produce **exactly one enrollment**, verified by concurrent-replay integration tests.
- Cut video worker cost ~X% by autoscaling the fleet on **queue depth** with spot capacity
  and graceful drain.
- Instrumented API + workers with OpenTelemetry, propagating trace context **through the job
  queue**; defined SLOs with multi-window burn-rate alerts and per-alert runbooks.
- Shipped Terraform-managed AWS infra (ECS Fargate, RDS Multi-AZ, CloudFront signed cookies)
  with an OIDC-authenticated GitHub Actions pipeline: **push → prod in under 10 minutes,
  zero downtime, one-click rollback.**

Fill in the X with a number you actually measured. Never with a guess.
