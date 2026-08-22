# Masternova — Build Plan & Tracker

> The file you open at the start of every session to decide what to do next.
> Plan: [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) · Pitch: [`PITCH.md`](./PITCH.md) · Rules: [`CLAUDE.md`](./CLAUDE.md)

**Created:** 2026-08-22 · **Last updated:** 2026-08-22 · **Status:** Phase 1A in progress — 1.1 platform kernel, 1.2 identity and 1.3 notification done; next up 1.4 (catalog)

---

## 1. How to use this file

**Build order:** backend → host it (DevOps) → frontend → connect → refine.
Backend depth modules (Phase 1B) sit _after_ integration so the project becomes deployable
and demoable as early as possible. Swap 1B to run straight after 1A if you prefer a pure
backend-first sequence — nothing in 1B blocks anything in 2–4.

**Status legend:** `☐` todo · `🔨` in progress · `✅` done · `⏸` deferred · `✂` cut

**Session ritual**

1. Open the dashboard (§2), pick the topmost `☐` task in the active phase.
2. Flip it to `🔨`. **Scaffold with `nest g …` before writing a line of logic** (§1.2).
3. Do the work — interface + `Symbol` token before implementation, force named in a comment.
4. Run the **`code-review`** skill on the diff, then **`simplify`**.
5. Before flipping to `✅`, walk the Definition of Done below. **All of it.**
6. Fill the Date column. Update the dashboard's Done/Spent columns.
7. Commit — conventional commits, **no `Co-Authored-By`, no AI attribution** (`CLAUDE.md` §9).

### 1.1 The order of work for every backend unit

Non-negotiable. `CLAUDE.md` §4 has the full generator list.

1. **`nest g …` to scaffold** — module, service, controller, guard, pipe, filter,
   interceptor, decorator. Never hand-create a block the CLI can generate; the generator
   wires the module graph and applies the naming conventions, and hand-written files drift
   from them immediately.
2. Define the **interface + `Symbol` injection token** _before_ the implementation (§1 D).
3. Write the implementation behind it, with a one-line comment **naming the force**.
4. Unit-test the pattern with **no database**; integration-test persistence with Testcontainers.
5. Write `docs/lld/<module>.md` — **in the same commit**.
6. Update the matching note in `../LLD/` with this code as its example.

Skipping step 1 is how you end up with a module that works and still reads as junior.

### 1.2 Use the right tool — skills, generators, CLIs

Before writing something by hand, check whether a generator, a skill, or an official CLI
already does it. Bespoke work is for what's genuinely specific to Masternova — the policy
chain, the outbox, the ledger — not for scaffolding, boilerplate, or review.

| When the task is…                                                                      | Use                                           | Not                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------- |
| A Nest module / service / controller / guard / pipe / filter / interceptor / decorator | **`nest g …`**                                | hand-created files            |
| A shadcn component                                                                     | `pnpm dlx shadcn@latest add <component>`      | copy-pasted markup            |
| A Prisma schema change                                                                 | `prisma migrate dev`                          | `db push`, hand-edited client |
| Reviewing a diff before committing                                                     | the **`code-review`** skill                   | eyeballing it                 |
| Tidying up after a feature lands                                                       | the **`simplify`** skill                      | leaving it                    |
| Checking the branch for security issues                                                | the **`security-review`** skill               | hoping                        |
| Any chart (Grafana panels, README graphs, k6 plots)                                    | the **`dataviz`** skill                       | ad-hoc chart code             |
| Designing a screen with no Figma source                                                | the **`design`** skill                        | guessing at layout            |
| Driving the running app to verify a change                                             | the **`run`** / **`claude-in-chrome`** skills | assuming it works             |
| Writing an LLD/OOP note in house style                                                 | the **`make-note`** skill                     | improvising the shape         |
| Committing to the right repo, no AI attribution                                        | the **`push-code`** skill                     | manual `git`                  |

### 1.3 Definition of Done — every backend task

Straight from `CLAUDE.md` §7.5. A task is not done when it works; it is done when it works
_and_ it is documented, **in the same commit**.

- [ ] Scaffolded with `nest g …`, not hand-created
- [ ] Every swappable dependency is an **interface + `Symbol` token**, provided via `{ provide: TOKEN, useClass: Impl }`
- [ ] Data access goes through a **repository behind an interface** — no scattered `PrismaService` calls
- [ ] Every abstraction has its **force named in a one-line comment**; abstractions without one are deleted (`CLAUDE.md` §3)
- [ ] No service over ~200 lines or 5 public methods (§3 — split it)
- [ ] `code-review` + `simplify` skills run on the diff
- [ ] Code + unit tests — patterns tested with **no database**
- [ ] Integration tests via **Testcontainers** where persistence is involved
- [ ] **Idempotency test** if reachable from a retry, a webhook, or a queue
- [ ] `docs/lld/<module>.md` complete, **both Mermaid diagrams present**
- [ ] `docs/hld/` updated if a container, dependency, or cross-context flow changed
- [ ] **ADR** written if a real alternative was rejected
- [ ] `docs/api/openapi.yaml` regenerated; `docs/db/` updated if the schema moved
- [ ] Matching pattern note in `../LLD/` updated with **this code** as its example

### 1.4 The prime directive check (`CLAUDE.md` §0)

> **Every backend module must be explainable on a whiteboard in an interview.**

Before marking any module `✅`, say all three out loud:

1. **Named responsibility** — one sentence on what this does and does not do.
2. **Named pattern + the force** that justified it, and the alternative rejected.
3. **Named seam** — where a second implementation would plug in.

Can't say all three? The design isn't finished. Don't tick the box.

**Corollary:** never accept generated code you can't explain. If a suggestion introduces a
pattern, it must also state the force. Code you can't defend is worse than no code, because
it will be on your resume.

And the inverse trap — **pattern overuse reads as junior faster than having no patterns at
all** (§3). One implementation is not a seam. Only abstract where a second implementation
genuinely exists or is planned: storage, payments, mail, search. Everywhere else a concrete
class is the correct design, and YAGNI beats speculative generality.

---

## 2. Progress dashboard

| Phase                                                       | Tasks  | Done   | Est       | Spent | Status |
| ----------------------------------------------------------- | ------ | ------ | --------- | ----- | ------ |
| [0 — Foundation](#5-phase-0--foundation)                    | 12     | 12     | 18 h      | ~9 h  | ✅     |
| [1A — Backend: core spine](#6-phase-1a--backend-core-spine) | 11     | 3      | 180 h     | ~20 h | 🔨     |
| [2 — DevOps & hosting](#8-phase-2--devops--hosting)         | 11     | 0      | 59 h      | —     | ☐      |
| [3 — Frontend](#9-phase-3--frontend)                        | 16     | 0      | 84 h      | —     | ☐      |
| [4 — Integration](#10-phase-4--integration)                 | 5      | 0      | 18 h      | —     | ☐      |
| [1B — Backend: depth](#7-phase-1b--backend-depth)           | 6      | 0      | 96 h      | —     | ☐      |
| [5 — Refinement & proof](#11-phase-5--refinement--proof)    | 8      | 0      | 42 h      | —     | ☐      |
| **Total**                                                   | **69** | **15** | **497 h** | ~29 h |        |

### ✅ Environment verified (2026-08-22)

| Tool   | Version | Notes                                                                         |
| ------ | ------- | ----------------------------------------------------------------------------- |
| Node   | 24.19.0 | via nvm; pinned in `.nvmrc`, `engines`, CI and `node:24-slim`                 |
| pnpm   | 11.5.0  | via corepack. **Overrides live in `pnpm-workspace.yaml`**, not `package.json` |
| Docker | 29.7.2  | Compose v5.5.0                                                                |

The `docker` group was added but needs a re-login to take effect in a shell;
until then prefix with `sg docker -c '<command>'`.

**Phase 0 exit check — all green**

```
pnpm install && pnpm --filter "./packages/**" build && pnpm db:generate
pnpm format:check && pnpm lint && pnpm typecheck        # clean
pnpm --filter @masternova/api test:int                   # 2 passed (real PG + Redis)
docker compose up -d --build                             # 6 services, api + worker healthy
```

Proven end-to-end: pgvector 0.8.6 installed · MinIO bucket + CORS created by the
init sidecar · migrations applied on boot · register → login → `/auth/me` works
with the session cookie, 401 without it, and Zod validation returns the error envelope.

### Gate A — "applyable" (~258 h)

Phases 0 + 1A + 2, plus the demo slice of Phase 3 (auth, catalog, checkout, player) and the
README. **At this line the project is deployed, demoable, and resume-ready.** Everything
after it is depth you add _while_ applying, not a blocker to applying.

> **Reality check.** 497 h at ~14.5 h/week is ~34 weeks. `DSA Learing/daily-tracker.md`
> records a switch deadline of **2026-11-28**, apply phase opening **Oct 20**. Those do not
> fit. That is why Gate A exists — it is the honest milestone, not the finish line.

---

## 2.1 Deviations from the plan (Phase 0)

Recorded because the tracker is only useful if it says what actually happened.

| Deviation                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Added `packages/db`** (not in the plan)                         | The worker needs the same models the API writes. Leaving the schema in `apps/api` made the worker's build reach into another app's files — the boundary violation §4 forbids between modules, one level up. The worker crashed on boot until this moved. Cheap now, expensive after Phase 1 puts 30 models in it.                                                                                                                                                                                       |
| **Dropped Loom's `queue` module** (plan §5 listed it)             | It was named for Loom's video domain. ADR-0002's whole argument is not carrying that forward. The `jobId` dedupe idea it carried is recorded against task 1.7.                                                                                                                                                                                                                                                                                                                                          |
| **Replaced `use-video-upload.ts` with `lib/multipart-upload.ts`** | The hook coupled the transport to React and to Loom's `/videos` endpoints. The valuable part — bounded concurrency, per-part retries, ETag handling — is now domain-free and testable without a DOM.                                                                                                                                                                                                                                                                                                    |
| **Node 24, not 22**                                               | The Dockerfiles already said `node:24-slim`; the CI pin was the outlier. 24 is the current active LTS.                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`apps/web` is foundation-only**                                 | shadcn primitives, auth form, lib helpers. Pages and the domain client are Phase 3.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **`BaseJobProcessor` deferred from 1.1 to 1.7**                   | The task listed it, but a Template Method with zero subclasses is exactly the speculative generality §3 forbids — "one implementation is not a seam". BullMQ is not even installed yet. It gets built in 1.7 where three real processors exist to shape the hooks.                                                                                                                                                                                                                                      |
| **Reinstated the AI layer** (2026-08-22, after Phase 0)           | The original cut argued recurring API cost, assuming a paid Whisper. Self-hosted removes the cost _and_ strengthens the worker-fleet story — two CPU-bound job types on one autoscaled pool. The cut also claimed transcode already proved the async signal, which was too narrow: timestamp-aligned chunking, hybrid retrieval, SSE streaming with backpressure, server-side token budgets and prompt-injection defence appear nowhere else in the plan. Now tasks 1.16–1.17 (Phase 1B) and 3.15–3.16. |

## 2.2 Deviations from the plan (Phase 1A)

| Deviation                                                          | Why                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Abstract Factory for channel families dropped from 1.3**         | The task named it for email / in-app / future SMS. There is one channel. An abstract factory with one concrete family is the speculative generality §3 forbids, and it would have to be defended with "for later", which is not a force. It arrives with in-app notifications in task 1.14, shaped by two real families instead of one imagined one.                            |
| **`DOMAIN_EVENT_HANDLER` multi-token replaced by discovery** (1.3) | Nest's `multi` providers do not merge across modules, so the second bounded context to register handlers would have silently shadowed the first — and injection required `outbox-relay` to import the consuming module, the cross-context import §4 forbids. Handlers are now marked `@EventHandler()` and found via `DiscoveryService`. Kernel LLD updated in the same commit. |
| **`@react-email/components` not used** (1.3)                       | The package is deprecated on npm. `@react-email/render` (current) does the part that matters — HTML plus a plaintext walk of the same element — and the layout is five small typed components. Shipping a deprecated dependency in a portfolio repo is a review comment waiting to happen.                                                                                      |
| **No ADR minted for 1.3**                                          | The two real alternatives — outbox vs direct send, and a token table vs a stateless HMAC unsubscribe — are ADR-0004 and `lld/notification` §7 respectively. §12's numbering reserves no slot for notification, and one ADR = one decision, not one per module.                                                                                                                  |
| **`/health` and `/readyz` marked `@Public()`** (1.3)               | Task 1.2 made authentication global and opt-out, which silently turned both into 401s. Found by running the stack, not by a test. Fixed here because that is the commit that noticed it.                                                                                                                                                                                        |

---

## 3. Decisions locked

Settled 2026-08-22. Do not re-litigate; if one changes, write an ADR.

| Decision    | Choice                                                                                           | Consequence                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Timeline    | **No hard deadline**                                                                             | Track by phase + effort, not week columns                                                                               |
| Repo        | **Fresh git repo**, hand-copy the good parts from Loom                                           | New history; see §5 for the copy list. ADR-0002                                                                         |
| Hosting     | **Full AWS + Terraform** — ECS Fargate, RDS, ElastiCache, S3, CloudFront signed cookies, OIDC CI | AWS account + domain already available                                                                                  |
| Cost        | **Local-first, deploy once**                                                                     | Everything verified on `docker compose`; one real apply → deploy → capture evidence → `destroy`. Re-apply for the demo. |
| Quality bar | **MAANG-level**                                                                                  | Cut only genuinely low-value items; each cut owes an ADR                                                                |
| Build order | backend → host → frontend → connect → refine                                                     | Reorders `PROJECT_PLAN.md` §11, which interleaved UI from Week 1                                                        |

### What exploration corrected in the existing docs

| Doc says                                                                | Reality on disk (2026-08-22)                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Fork Loom — Week 1 is a rename, not a rebuild" (`PROJECT_PLAN.md` §11) | Loom is **10 commits, ~60 files**: no tests, no ESLint, no CI, no Prisma migrations, no prod Dockerfiles, no ffmpeg. Its only worker processor logs and returns. Real plumbing, **zero domain**.                                                                                                      |
| "Built from an existing full Figma, so UI is a solved problem"          | No `.fig` and no figma.com URL anywhere in the workspace. It exists off-machine — extracting tokens from it is the first Phase 3 task.                                                                                                                                                                |
| "`LLD/` feeds `docs/lld/`"                                              | `LLD/` is **missing every behavioral pattern Masternova implements** — Strategy, Observer, State (its README marks all three **P0**), Command, Template Method, Chain of Responsibility, plus Specification and Repository. There is no `LLD/6. Behavioural Design Patterns/` folder at all. See §13. |

---

## 4. Scope — built vs cut

### Built (the `PROJECT_PLAN.md` §11 cut list is mostly reinstated)

Reviews + rating aggregation (§4.8) · Typesense + pgvector search (§4.7) · double-entry
payout ledger (§4.3) · coupons · refunds · analytics rollups · full transactional email ·
**self-hosted transcription + "ask this video" RAG** (tasks 1.16–1.17).

### Cut — each owes an ADR

| Cut                                                                          | Why                                                                                                                                                                                                                                                | ADR    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Managed transcription API (Whisper API, AWS Transcribe)                      | Transcription is **self-hosted in the worker** instead — free, and it is CPU-bound and bursty, which is precisely the load profile that justifies a separately-autoscaled worker fleet. Paying per minute would cost money _and_ weaken the story. | `0007` |
| Helm / K8s variant                                                           | ECS is the live target. A second orchestrator is config, not signal — `PROJECT_PLAN.md` §12 already agrees.                                                                                                                                        | `0008` |
| Certificates                                                                 | A PDF generator. No interesting force behind it.                                                                                                                                                                                                   | `0009` |
| Microservices-first, Kafka, service mesh, custom DRM, multi-tenancy, GraphQL | `PROJECT_PLAN.md` §12. §10 is the answer if asked.                                                                                                                                                                                                 | `0001` |

Being able to say _"I scoped that out on purpose, and here's the design I'd build"_ is a
stronger signal than a half-finished implementation. Interviewers probe scope judgement.

---

## 5. Phase 0 — Foundation

**Est 18 h** · Goal: a fresh repo where `docker compose up` works, CI is green, and the
conventions in `CLAUDE.md` are mechanically enforced rather than merely written down.

### Target layout

```
Masternova/
  apps/{api,worker,web}        packages/{shared,contracts}
  infra/{terraform,docker}     docs/{hld,lld,adr,api,db,runbooks}
  .github/workflows/           docker-compose.yml  Makefile
```

### Copy list — from `../Loom Lite AI/`

Rename `@loom/*` → `@masternova/*`, `loom_session` cookie, bucket and DB names.

| Source path                                                                           | Why it's worth keeping                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/config/{configuration.ts,env.validation.ts}`                            | Zod `envSchema` + 5 namespaced `registerAs` factories. Already satisfies `CLAUDE.md` §4's "never read `process.env` outside `src/config/`".                                                                              |
| `apps/api/src/common/**`                                                              | `all-exceptions.filter.ts`, `zod-validation.pipe.ts` + the `@ZodBody(schema)` decorator, `authenticated.guard.ts`, `@CurrentUserId()`, `bigint-serializer.interceptor.ts`, `utils/slug.ts`, the domain-exception barrel. |
| `apps/api/src/prisma/{prisma.module.ts,prisma.service.ts}`                            | Global module, unchanged.                                                                                                                                                                                                |
| `apps/api/src/modules/auth/**`                                                        | argon2id, local + conditionally-provided Google strategy, `@fastify/secure-session`. Seed of `identity`.                                                                                                                 |
| `apps/api/src/modules/users/repositories/*`                                           | The interface + `Symbol` token repository pattern `CLAUDE.md` §1 mandates. Copy the _shape_, replace the model.                                                                                                          |
| `apps/api/src/modules/storage/**`                                                     | S3 multipart (create/presign-part/complete/abort) and the **dual-S3Client trick** — internal `minio:9000` vs public `localhost:9000` for browser-signed URLs. Non-obvious; hours to rediscover.                          |
| `apps/api/src/modules/queue/**`                                                       | BullMQ producer behind `IVideoQueue` + Symbol token, `jobId: process-${id}` dedupe already in place.                                                                                                                     |
| `apps/api/src/modules/health/**`                                                      | Unchanged.                                                                                                                                                                                                               |
| `apps/worker/src/{main.ts,app.module.ts}`                                             | `createApplicationContext` (no HTTP) + shutdown hooks + BullMQ bootstrap.                                                                                                                                                |
| `apps/web/hooks/use-video-upload.ts`                                                  | 114-line **parallel multipart uploader** — `MAX_CONCURRENT=4`, 3 part-retries, ETag reads, progress phases. Feeds the instructor wizard directly.                                                                        |
| `apps/web/hooks/use-auth-form.ts`                                                     | RHF + `zodResolver`, login/register toggle.                                                                                                                                                                              |
| `apps/web/{lib/api.ts,lib/format.ts,lib/utils.ts}`                                    | Typed fetch wrapper + `ApiError`, `credentials:'include'`.                                                                                                                                                               |
| `apps/web/{components/ui,components/common,components/auth}`                          | shadcn (new-york / zinc / cssVariables) primitives + RHF-bound fields.                                                                                                                                                   |
| `apps/web/{globals.css,tailwind.config.ts,components.json,next.config.ts}`            | Full light+dark CSS-var block; `next.config.ts` rewrites `/api/*` → API so the session cookie stays **first-party**.                                                                                                     |
| `docker-compose.yml`, the 3 dev Dockerfiles                                           | Working stack: pgvector/pg16, redis, minio, mailpit, all with healthchecks.                                                                                                                                              |
| `pnpm-workspace.yaml`, `tsconfig.base.json`, `.prettierrc`, `.npmrc`, `.dockerignore` | Root tooling.                                                                                                                                                                                                            |

**Do NOT copy:** `modules/videos` + `modules/uploads` _domain_ semantics (keep mechanics,
replace meaning) · `hooks/use-recorder.ts` (342 L of MediaRecorder) · `hooks/use-videos.ts`
· `components/{videos,record,upload}` · `packages/ai` (40-line unused stub) · the entire
Prisma domain · `app/(app)/*` pages.

### Tasks

| #    | Task                                                                                                                                                                                                                             | Notes                                                  | Est   | Status | Date       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----- | ------ | ---------- |
| 0.1  | `git init` in `Masternova/`, remote `github.com/b-nimai/Masternova.git`, `.gitignore`, branch protection                                                                                                                         | Fresh history (ADR-0002)                               | 1 h   | ✅     | 2026-08-22 |
| 0.2  | Monorepo skeleton + copy list above, rename `@loom/*` → `@masternova/*`                                                                                                                                                          |                                                        | 3 h   | ✅     | 2026-08-22 |
| 0.3  | **Fix:** make `apps/api` + `apps/worker` tsconfigs extend `tsconfig.base.json`                                                                                                                                                   | They're standalone in Loom                             | 0.5 h | ✅     | 2026-08-22 |
| 0.4  | **Fix:** add ESLint — none exists anywhere in Loom despite `lint` scripts. Include the **import-boundary rule** enforcing `CLAUDE.md` §4: no cross-module internal imports; modules see each other only via `packages/contracts` | Makes the architecture rule mechanical                 | 2 h   | ✅     | 2026-08-22 |
| 0.5  | **Fix:** replace `prisma db push` with real `migrations/` + `migrate deploy` in compose                                                                                                                                          | `db push` outside local dev is banned (`CLAUDE.md` §4) | 1 h   | ✅     | 2026-08-22 |
| 0.6  | **Fix:** add a MinIO `mc` init sidecar — bucket + **CORS exposing `ETag`** + policy                                                                                                                                              | The uploader needs `ETag`; Loom has no init container  | 1 h   | ✅     | 2026-08-22 |
| 0.7  | **Fix:** enable pgvector (`postgresqlExtensions`) — the image is `pgvector/pgvector:pg16` but the extension is never enabled                                                                                                     |                                                        | 0.5 h | ✅     | 2026-08-22 |
| 0.8  | **Fix:** wire Prisma into `apps/worker` — it gets `DATABASE_URL` but has no client. Drop the unused `@fastify/cookie` dep                                                                                                        |                                                        | 1 h   | ✅     | 2026-08-22 |
| 0.9  | Create `packages/contracts` — empty but real. **This is the §4 seam and does not exist in Loom**                                                                                                                                 | Module public interfaces live here                     | 1 h   | ✅     | 2026-08-22 |
| 0.10 | Test harness: Jest + `@nestjs/testing` + **Testcontainers**, with one green integration test proving real Postgres + Redis spin up                                                                                               | Loom has **zero** tests                                | 3 h   | ✅     | 2026-08-22 |
| 0.11 | `docs/` tree per `CLAUDE.md` §7.1; commit §7.3's LLD template as `docs/lld/_TEMPLATE.md`                                                                                                                                         | Never improvise the shape per file                     | 1 h   | ✅     | 2026-08-22 |
| 0.12 | GH Actions: lint + typecheck + unit + integration on every PR, from day one                                                                                                                                                      |                                                        | 3 h   | ✅     | 2026-08-22 |

**ADRs due this phase:** `0001-modular-monolith.md`, `0002-fresh-repo-over-fork.md` — write
them now, while the reasoning is fresh.

**Phase 0 exit check**

```bash
docker compose up -d --build
pnpm -r typecheck && pnpm -r lint && pnpm -r test    # all green
```

---

## 6. Phase 1A — Backend: core spine

**Est 180 h** · Ordered by dependency. Every task carries the §1 Definition of Done.

| #    | Module                    | The interesting problem                                                                                                                                                                                                                                                                                                                                                                                 | Patterns & the force                                                                                                                                                                                 | Est  | Status | Date  | Docs owed                                     |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ----- | --------------------------------------------- |
| 1.1  | **platform kernel**       | Domain events + **transactional outbox** + relay worker · `idempotency_records` · Unit of Work · `BaseJobProcessor`. Built first because everything later depends on it.                                                                                                                                                                                                                                | **Observer** (one cause, many independently-failing effects) · **Template Method** (`validate→execute→persist→emit`) · **Repository + UoW** (outbox rows commit in the same txn as the state change) | 14 h | ✅     | 08-22 | `lld/platform-kernel` · ADR-0004              |
| 1.2  | **identity**              | argon2id · **refresh-token rotation with reuse detection** · device sessions · RBAC roles · email verification · password reset. Never "I used JWT" (`PITCH.md`).                                                                                                                                                                                                                                       | **Strategy** (auth strategies) · **Repository**                                                                                                                                                      | 16 h | ✅     | 08-22 | `lld/identity` · ADR-0010                     |
| 1.3  | **notification**          | Transactional email as a real module — see the catalogue below. `MailProvider` port with Mailpit (dev) / Resend or SES (prod) · React Email templates as typed components · **every send driven off the outbox** so an SMTP outage never rolls back a business transaction · delivery log, retries, bounces, unsubscribe, per-user preferences.                                                         | **Adapter** (3rd-party API ≠ your domain interface) · **Abstract Factory** (channel families: email / in-app / future SMS) · **Template Method** (render→send→record) · **Observer**                 | 16 h | ✅     | 08-22 | `lld/notification`                            |
| 1.4  | **catalog**               | Course / Section / Lecture / Category / pricing / publish state. Split `CourseReader` / `CourseWriter` (ISP). Composable filter predicates. Seed **10k courses**, tune with `EXPLAIN ANALYZE`, **record the before/after**.                                                                                                                                                                             | **Specification** (runtime-composed rules without a query-builder explosion) · **Repository** · **Prototype** ("duplicate this course")                                                              | 18 h | ☐      |       | `lld/catalog` · `db/indexes` w/ EXPLAIN       |
| 1.5  | **catalog-authoring**     | Wizard backend: draft state machine `DRAFT→IN_REVIEW→PUBLISHED→ARCHIVED`, per-step validation, publish gate ("every section has ≥1 lecture, all media READY, price set"), **autosave with optimistic concurrency** (`version` column, 409 on conflict — two open tabs is a real bug you handle).                                                                                                        | **State** (illegal transitions impossible) · **Builder** (stepwise assembly, validated before legal) · **Command** (undoable step edits)                                                             | 14 h | ☐      |       | `lld/wizard-draft-state`                      |
| 1.6  | **media**                 | Upload sessions · **resumable** presigned multipart (kill the network, resume from part N) · asset model · `StorageProvider` port — MinIO ≡ S3, **no implementation may throw `NotSupportedError`** (`CLAUDE.md` §1 L).                                                                                                                                                                                 | **Adapter** · **State** (upload session lifecycle)                                                                                                                                                   | 12 h | ☐      |       | `lld/media`                                   |
| 1.7  | **worker pipeline**       | Job DAG: `probe → transcode(240/480/720/1080 fanout) → package HLS → sprite+poster`. ffmpeg ABR ladder. **Idempotent workers** (deterministic output keys, upsert-on-conflict), exponential backoff, **DLQ + replay endpoint**, SSE progress to the wizard, reconciliation sweeper for orphaned S3 objects.                                                                                             | **Factory Method** (handler resolution by job type) · **Template Method** (`BaseJobProcessor`) · **Strategy** (transcode profiles) · **Builder** (ffmpeg HLS command)                                | 24 h | ☐      |       | `lld/video-pipeline` · ADR-0003               |
| 1.8  | **entitlement** ⭐        | _The crown jewel._ Policy chain, each returning `ALLOW / DENY / ABSTAIN`, **explicit DENY wins**. Decision cached in Redis `ent:{userId}:{courseId}`, invalidated by order / refund / publish events. Enforced at **three layers**: API guard → 5-min signed playback token (bound to user + lecture + IP) → CloudFront signed cookie on the HLS path. _A leaked manifest URL is dead in five minutes._ | **Chain of Responsibility** (ordered rules, any may decide or pass) · **Strategy** (policies) · **Specification** · **Decorator** (cache wrapper over the repository)                                | 18 h | ☐      |       | `lld/entitlement-engine`                      |
| 1.9  | **commerce**              | Cart · `PricingService` **separate from** `OrderService` (`CLAUDE.md` §1 S) · coupons · order state machine · `Idempotency-Key` header + stored request-hash/response · Razorpay adapter · **webhook dedupe on provider event id**, out-of-order arrival, webhook-before-redirect · outbox → enroll + invoice + email · refunds revoking entitlement.                                                   | **State** (forward-only transitions) · **Adapter** (Razorpay → `PaymentProvider`) · **Facade** (`CheckoutService` over cart+pricing+payment+order) · **Observer**                                    | 26 h | ☐      |       | `lld/order-state-machine` · `api/conventions` |
| 1.10 | **enrollment & progress** | Entitlement records. Heartbeats → **Redis write-back buffer**, flushed every 30 s / on pause / on `beforeunload` via `sendBeacon`. Monotonic `maxPositionSeconds`. Rollups for "% complete". **The documented tradeoff:** up to 30 s of progress lost on a Redis failure — acceptable for a progress bar, _not_ for the payment path, which is why that one is fully transactional.                     | **Decorator** (write-back cache)                                                                                                                                                                     | 12 h | ☐      |       | `lld/progress` · ADR-0011                     |
| 1.11 | **API hardening**         | Generated OpenAPI · rate limiting · cursor pagination · error envelope · versioning · helmet + CORS · schemathesis contract tests.                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                    | 10 h | ☐      |       | `api/openapi.yaml` · `api/conventions.md`     |

### 6.1 Email catalogue

Owned by task 1.3, emitted by 1.2 / 1.5 / 1.7 / 1.9 / 1.10 / 1.14. Every one is an
**outbox event → relay worker → `MailProvider`** — never a direct send on the request path.

| Trigger                        | Email                                                                            | Emitted by         |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------ |
| Signup                         | **Verify your email** (signed, single-use, expiring token)                       | identity           |
| Verified                       | Welcome + getting started                                                        | identity           |
| Forgot password                | **Reset link** (single-use, expiring, invalidated on use)                        | identity           |
| Password changed               | Security notice — "this wasn't you?"                                             | identity           |
| New device / suspicious login  | Security alert (ties into refresh-reuse detection)                               | identity           |
| Order paid                     | **Receipt + invoice**                                                            | commerce           |
| Payment failed / order expired | Recovery email with a resume-checkout link                                       | commerce           |
| Refund processed               | Refund confirmation + access-revoked notice                                      | commerce           |
| Enrolled                       | Course access + where to start                                                   | enrollment         |
| Course published               | Instructor confirmation                                                          | catalog-authoring  |
| Transcript ready               | Instructor notification — captions and ask-the-video are now live on the lecture | transcription (1B) |
| Transcode failed               | Instructor alert with the DLQ replay link                                        | media / worker     |
| New review on your course      | Instructor notification (respects preferences)                                   | engagement (1B)    |
| New Q&A question / answer      | Both directions                                                                  | engagement (1B)    |
| Contact form submitted         | Copy to admin + acknowledgement to sender                                        | engagement (1B)    |
| Payout batch settled           | Instructor statement                                                             | ledger (1B)        |
| Any                            | Unsubscribe / preference-centre link in every non-transactional footer           | notification       |

**Design points worth defending in an interview.** Email is an _independently-failing
effect_ — that is precisely the force behind the outbox (`CLAUDE.md` §2). Sends are
**idempotent per `(eventId, template, recipient)`**, so a relay retry cannot double-send.
Link tokens are single-use and expiring. Templates are typed React Email components sharing
one layout, so the Figma email designs become code rather than pasted HTML. Locally
everything lands in **Mailpit** (`:8025`) — already in Loom's compose — so the whole flow is
testable with no external account and no cost.

### 6.2 Tests that must exist by the end of 1A

These are the interview artifacts, not box-ticking.

- [ ] **SIGKILL a worker mid-transcode** → job re-runs, zero duplicate renditions, no orphaned S3 objects
- [ ] **Fire one webhook 50× concurrently** → exactly one enrollment, one invoice, one email
- [x] **Relay the same outbox row twice → still exactly one email** (1.3 — `apps/worker/test/notification.int-spec.ts`)
- [ ] Replay an `Idempotency-Key` → stored response returned, **no second charge**
- [ ] A non-enrolled user blocked at the API guard **and** at the CDN path
- [ ] Two concurrent wizard saves → one wins, the other gets a 409
- [ ] Policy chain unit tests — **no database**

---

## 7. Phase 1B — Backend: depth

**Est 96 h** · Runs after Phase 4 by default (keeps the project deployable earliest), or
straight after 1A if you prefer pure backend-first.

| #    | Module                     | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Patterns                                                                                                                                                                                                                                                              | Est  | Status | Date |
| ---- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ---- |
| 1.12 | **ledger**                 | Double-entry instructor payouts — every rupee move is **two rows that sum to zero**. Platform fee split, tax withholding, refund reversal, payout batches. Immutable append-only; balances derived, never stored. Rare in portfolios, instantly credible.                                                                                                                                                                                                                                                                     | **Command** (postings as first-class objects) · **Specification**                                                                                                                                                                                                     | 18 h | ☐      |      |
| 1.13 | **search**                 | Typesense (typo-tolerant, faceted: level/price/rating/category/language) + **pgvector** semantic search over course and lecture text. Index synced **via the same outbox — never dual-write.** Backfill/reindex CLI. Ranking blend: relevance × enrollment × rating × recency, tunable and explained.                                                                                                                                                                                                                         | **Observer** · **Strategy** (ranking) · **Adapter**                                                                                                                                                                                                                   | 20 h | ☐      |      |
| 1.14 | **engagement**             | Reviews + **incremental** rating aggregation: denormalized `rating_count` / `rating_sum` / 1–5 histogram updated **inside the review transaction**, edits and deletes applying deltas, plus a reconciliation job that **proves the denormalized value never drifts**. Q&A. Contact messages.                                                                                                                                                                                                                                  | **Observer** · **Specification**                                                                                                                                                                                                                                      | 14 h | ☐      |      |
| 1.15 | **analytics**              | Append-only event ingest, periodic rollups, instructor revenue dashboard queries.                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                     | 12 h | ☐      |      |
| 1.16 | **transcription**          | Audio extracted in the existing job DAG → **self-hosted Whisper** in the worker → timestamped transcript segments → WebVTT captions on the player → transcript text feeds course search. No paid API, and it makes the worker fleet genuinely multi-workload: two CPU-bound job types competing for one autoscaled pool is a far better queue-depth story than one.                                                                                                                                                           | **Strategy** (transcription providers: local whisper.cpp · managed API · a fake for tests — genuinely interchangeable) · **Template Method** (reuses `BaseJobProcessor`)                                                                                              | 14 h | ☐      |      |
| 1.17 | **ask-the-video (RAG)** ⭐ | Chunk the transcript on **timestamp boundaries**, embed into pgvector, hybrid retrieve (vector + keyword), answer over **SSE streaming** with citations that seek the player to `4:12`. Guarded by a **per-user token budget enforced server-side** and an input-scrubbing layer, because instructor-supplied content flows into an LLM. **Entitlement-gated** — you may only ask about a lecture you may watch, so the policy chain from task 1.8 applies unchanged. That reuse is the payoff of having built it as a chain. | **Adapter** (LLM provider ≠ your `ChatProvider` interface) · **Decorator** (budget guard + response cache wrapping the provider — cost control without touching the subject or its callers) · **Specification** (retrieval filters) · **Strategy** (embedding models) | 18 h | ☐      |      |

---

## 8. Phase 2 — DevOps & hosting

**Est 59 h** · Written and verified locally, then **one real `terraform apply` → deploy →
verify → capture evidence → `terraform destroy`**, per the local-first/deploy-once decision.
Terraform makes the re-apply for the final demo cheap.

| #    | Task                                                                                                                                                                                                                                                                                                                       | Notes                                                                                                                                             | Est  | Status | Date |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ---- |
| 2.1  | Production multi-stage Dockerfiles (deps → build → runtime), non-root, distroless, `HEALTHCHECK`, tight `.dockerignore`, pnpm store cache mounts                                                                                                                                                                           | **Record image size before/after** — it's a README number                                                                                         | 6 h  | ☐      |      |
| 2.2  | Full GH Actions pipeline: lint → typecheck → unit → integration (Testcontainers) → buildx → **Trivy** → SBOM (syft) → push ECR. Reusable workflows, matrix, cache                                                                                                                                                          |                                                                                                                                                   | 8 h  | ☐      |      |
| 2.3  | Terraform foundations: remote state (S3 + DynamoDB lock), module layout, workspaces, **OIDC provider + least-privilege role**                                                                                                                                                                                              | **Zero long-lived AWS keys in the repo.** Say this in the interview                                                                               | 8 h  | ☐      |      |
| 2.4  | Terraform data plane: RDS Postgres (PITR), ElastiCache, S3 (masters / hls / assets with lifecycle → IA → Glacier), Secrets Manager                                                                                                                                                                                         |                                                                                                                                                   | 8 h  | ☐      |      |
| 2.5  | **Production email**: verify the sending domain, **SPF + DKIM + DMARC** in Route53, SES (out of sandbox) or Resend behind the same `MailProvider` port. Bounce/complaint webhook → delivery log                                                                                                                            | The adapter means this is a **config change, not a code change** — that's the payoff of §1.3. Deliverability is what most portfolio projects skip | 4 h  | ☐      |      |
| 2.6  | Terraform compute: VPC (public/private + NAT), ALB + ACM + Route53 on the real domain, ECS Fargate services (api, worker), per-task IAM roles, CloudWatch alarms                                                                                                                                                           |                                                                                                                                                   | 10 h | ☐      |      |
| 2.7  | **CloudFront + OAC + signed cookies** on the HLS path                                                                                                                                                                                                                                                                      | This is what makes a leaked manifest URL worthless                                                                                                | 6 h  | ☐      |      |
| 2.8  | CD: **expand-contract** migrations (add column → backfill → dual-write → switch → drop), blue/green deploy, smoke test, **auto-rollback on failure**                                                                                                                                                                       | Target: `git push` → prod in **< 10 min**, zero downtime, one-click rollback                                                                      | 8 h  | ☐      |      |
| 2.9  | Autoscaling: API target-tracking on CPU + ALB RPS; **workers autoscale on BullMQ queue depth** (custom CloudWatch metric → ECS step scaling), spot capacity, graceful SIGTERM drain returning the job to the queue, scale-to-zero when idle                                                                                | Queue depth is the signal that correlates with "learners are waiting". **The DevOps detail interviewers remember**                                | 6 h  | ☐      |      |
| 2.10 | Observability: OTel across API and worker, **trace context propagated through the BullMQ job payload** so one trace spans `POST /checkout → webhook → outbox relay → email sent`. Prom / Grafana / Loki / Tempo, RED + USE + business metrics, `docs/slo.md` with multi-window burn-rate alerts, **one runbook per alert** | `PROJECT_PLAN.md` §7: that trace screenshot is the single most convincing image in the project                                                    | 12 h | ☐      |      |
| 2.11 | `make up` / `make down` + a budget alarm                                                                                                                                                                                                                                                                                   | The account must not quietly bill                                                                                                                 | 2 h  | ☐      |      |

**SLO targets** (`docs/slo.md`): API availability 99.9%, p95 < 300 ms · video start (click →
first frame) < 2 s p95 · upload → playable < 5 min p95.

---

## 9. Phase 3 — Frontend

**Est 84 h** · Points at local compose throughout; deployed in Phase 4.
`CLAUDE.md` §5: reusable components first, thin pages, server components by default,
`"use client"` only for interactive islands. **Extract design tokens once — don't hand-tune
spacing per screen.**

| #    | Task                                                                                                                                                | Notes                                                         | Est  | Status | Date |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---- | ------ | ---- |
| 3.1  | **Extract design tokens from the Figma** (it lives off-machine) + build the component library on top of Loom's shadcn base                          | Everything else depends on this                               | 8 h  | ☐      |      |
| 3.2  | TanStack Query + a typed client generated from `@masternova/shared`                                                                                 | Loom has **no** data layer — `useState`+`useEffect` only      | 4 h  | ☐      |      |
| 3.3  | `middleware.ts` for real server-side route protection                                                                                               | Loom's was client-side only (401 → `router.push`)             | 2 h  | ☐      |      |
| 3.4  | Auth screens: signup · login · forgot password · reset · set-new-password · **verify-email landing**                                                | _Gate A_                                                      | 6 h  | ☐      |      |
| 3.5  | **Notification preference centre + one-click unsubscribe page**                                                                                     | Links inside the emails ⇒ frontend work the catalogue creates | 3 h  | ☐      |      |
| 3.6  | Home                                                                                                                                                |                                                               | 4 h  | ☐      |      |
| 3.7  | Course list — search, filter, facets, pagination                                                                                                    | _Gate A_                                                      | 7 h  | ☐      |      |
| 3.8  | Course detail                                                                                                                                       | _Gate A_                                                      | 5 h  | ☐      |      |
| 3.9  | Cart → checkout → payment callback → order confirmation                                                                                             | _Gate A_                                                      | 8 h  | ☐      |      |
| 3.10 | **HLS player** — hls.js + signed cookies + progress heartbeats + `sendBeacon`                                                                       | _Gate A_ · the demo centrepiece                               | 8 h  | ☐      |      |
| 3.11 | Profile · edit profile · my enrolled courses                                                                                                        |                                                               | 5 h  | ☐      |      |
| 3.12 | Review modal + ratings display                                                                                                                      |                                                               | 3 h  | ☐      |      |
| 3.13 | Instructor: dashboard · all-courses · **multistep wizard** reusing Loom's `use-video-upload.ts` and consuming the SSE transcode progress            |                                                               | 10 h | ☐      |      |
| 3.14 | About · contact                                                                                                                                     |                                                               | 2 h  | ☐      |      |
| 3.15 | **Ask-the-video panel** beside the player — streaming answers, citation chips that seek the player to the timestamp, visible remaining token budget | Pairs with task 1.17                                          | 6 h  | ☐      |      |
| 3.16 | Captions (WebVTT) + searchable in-lecture transcript                                                                                                | Pairs with task 1.16                                          | 3 h  | ☐      |      |

---

## 10. Phase 4 — Integration

**Est 18 h**

| #   | Task                                                            | Est | Status | Date |
| --- | --------------------------------------------------------------- | --- | ------ | ---- |
| 4.1 | Cross-origin cookie / CORS / domain wiring against deployed AWS | 4 h | ☐      |      |
| 4.2 | Deploy `apps/web` (ECS or Amplify behind the same CloudFront)   | 4 h | ☐      |      |
| 4.3 | Sentry + Web Vitals RUM                                         | 2 h | ☐      |      |
| 4.4 | **Playwright e2e: signup → buy → watch → review**, green in CI  | 6 h | ☐      |      |
| 4.5 | Full-stack smoke test wired into the CD gate                    | 2 h | ☐      |      |

---

## 11. Phase 5 — Refinement & proof

**Est 42 h** · This is where the resume lines get their numbers. Nothing here is optional —
`PITCH.md`: _"It's scalable" → give a number from a load test, or say nothing._

| #   | Task                                                                                                                       | Est | Status | Date |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --- | ------ | ---- |
| 5.1 | **k6**: 1,000 concurrent learners; publish p50/p95/p99                                                                     | 6 h | ☐      |      |
| 5.2 | **One real tuning story** with a before/after `EXPLAIN ANALYZE` (e.g. sequential scan → composite index, 400 ms → 40 ms)   | 6 h | ☐      |      |
| 5.3 | **Chaos drills**: kill a worker mid-job · kill the DB primary · replay webhooks · fill the DLQ and drain it                | 6 h | ☐      |      |
| 5.4 | **PITR restore drill actually executed** to a scratch instance; RTO/RPO documented                                         | 4 h | ☐      |      |
| 5.5 | `docs/hld/00–05` complete — C4 L1/L2, capacity estimation for 100k learners, data flows, failure modes, the 10x split plan | 6 h | ☐      |      |
| 5.6 | Every `docs/lld/<module>.md` complete · full ADR set · runbooks · `docs/db/indexes.md` with EXPLAIN evidence               | 5 h | ☐      |      |
| 5.7 | README a stranger understands in 5 minutes · **the cross-queue trace screenshot** · demo video                             | 5 h | ☐      |      |
| 5.8 | **`../LLD/` note backfill** — see §13                                                                                      | 4 h | ☐      |      |

---

## 12. Doc debt tracker

`CLAUDE.md` §7: _a module is not done when it works; it is done when it works and it is
documented_ — **in the same commit as the code.** A doc written later is written from memory
and therefore wrong.

### `docs/lld/`

| File                       | Phase | Class dia. | Seq dia. | §11 recall | Status |
| -------------------------- | ----- | ---------- | -------- | ---------- | ------ |
| `platform-kernel.md`       | 1.1   | ✅         | ✅       | ✅         | ✅     |
| `identity.md`              | 1.2   | ✅         | ✅       | ✅         | ✅     |
| `notification.md`          | 1.3   | ✅         | ✅       | ✅         | ✅     |
| `catalog.md`               | 1.4   | ☐          | ☐        | ☐          | ☐      |
| `wizard-draft-state.md`    | 1.5   | ☐          | ☐        | ☐          | ☐      |
| `media.md`                 | 1.6   | ☐          | ☐        | ☐          | ☐      |
| `video-pipeline.md`        | 1.7   | ☐          | ☐        | ☐          | ☐      |
| `entitlement-engine.md` ⭐ | 1.8   | ☐          | ☐        | ☐          | ☐      |
| `order-state-machine.md`   | 1.9   | ☐          | ☐        | ☐          | ☐      |
| `progress.md`              | 1.10  | ☐          | ☐        | ☐          | ☐      |
| `ledger.md`                | 1.12  | ☐          | ☐        | ☐          | ☐      |
| `search.md`                | 1.13  | ☐          | ☐        | ☐          | ☐      |
| `engagement.md`            | 1.14  | ☐          | ☐        | ☐          | ☐      |
| `transcription.md`         | 1.16  | ☐          | ☐        | ☐          | ☐      |
| `ask-the-video.md` ⭐      | 1.17  | ☐          | ☐        | ☐          | ☐      |

> §11 "Interview notes — 60-second recall" is the highest-value part of each file. Write it
> **last**, keep it to genuinely sixty seconds, and keep it in the same shape as your
> `LLD/0. Index.md` notes so revision feels familiar.

### `docs/adr/` — one decision per file, numbered, never deleted (superseded instead)

| #    | Decision                                              | Phase | Status |
| ---- | ----------------------------------------------------- | ----- | ------ |
| 0001 | Modular monolith over microservices                   | 0     | ☐      |
| 0002 | Fresh repo over forking Loom Lite AI                  | 0     | ☐      |
| 0003 | HLS over progressive MP4                              | 1.7   | ☐      |
| 0004 | Outbox over direct publish                            | 1.1   | ✅     |
| 0005 | ECS Fargate over EKS                                  | 2.6   | ☐      |
| 0006 | Typesense over Elasticsearch                          | 1.13  | ☐      |
| 0007 | Self-hosted Whisper over a managed transcription API  | 4     | ☐      |
| 0008 | Helm/K8s variant cut                                  | 4     | ☐      |
| 0009 | Certificates cut                                      | 4     | ☐      |
| 0010 | Refresh rotation + reuse detection over stateless JWT | 1.2   | ✅     |
| 0011 | Redis write-back for progress (accepting 30 s loss)   | 1.10  | ☐      |
| 0012 | Postgres + pgvector over a dedicated vector DB        | 1.13  | ☐      |
| 0013 | SSE streaming over WebSocket for chat responses       | 1.17  | ☐      |
| 0014 | Token budget guard as a Decorator, not middleware     | 1.17  | ☐      |

### `docs/hld/`, `docs/runbooks/`, `docs/api/`, `docs/db/`

Written **incrementally** — update `docs/hld/` the week a container or cross-context flow
first appears, not in Phase 5. One runbook per alert, created with the alert.

---

## 13. `../LLD/` note backfill

Your `LLD/` repo is missing **every behavioral pattern Masternova implements**, and its own
README marks Strategy / Observer / State as **P0**. There is no `LLD/6. Behavioural Design
Patterns/` folder yet — create it.

`CLAUDE.md` §7.2 makes this mandatory: _implemented a design pattern → update the matching
note in `../LLD/`, using this code as its example._ That's what converts study notes into
lived experience, which is what makes them survive interview pressure.

**House format** (confirmed from `5. Structural Design Patterns/3. Facade Pattern.md`):
`# Title` → `> **One-liner:**` → `**Trigger phrase:**` → `> **Load-bearing idea:**` → `---` →
`## Core Idea` (with "Reach for it when", `### Real-life analogy`, `### Structure (N parts)`)
→ `## ⭐ Worked example` with ❌ without / ✅ with → pros/cons → `## Pitfalls`.
Then add the row to `0. Index.md`: `# | Topic | Trigger phrase | 30-sec revision`.

| Pattern                         | Priority | Masternova code that becomes its worked example                     | Status |
| ------------------------------- | -------- | ------------------------------------------------------------------- | ------ |
| **Strategy**                    | P0       | entitlement policies · payment providers · transcode profiles       | ☐      |
| **Observer**                    | P0       | domain events → outbox → enroll / invoice / email / index           | ☐      |
| **State**                       | P0       | order state machine · course draft lifecycle · upload session       | ☐      |
| **Command**                     | P1       | wizard step edits (undoable) · queue job payloads · ledger postings | ☐      |
| **Template Method**             | P2       | `BaseJobProcessor`: `validate → execute → persist → emit`           | ☐      |
| **Chain of Responsibility**     | P2       | entitlement engine — `ALLOW / DENY / ABSTAIN`, explicit DENY wins   | ☐      |
| **Specification**               | —        | course search/filter predicates, composable with `and` / `or`       | ☐      |
| **Repository (+ Unit of Work)** | —        | all persistence; outbox rows in the same txn as the state change    | ☐      |

Existing notes to **update** with Masternova examples: Adapter (Razorpay → `PaymentProvider`,
S3/MinIO → `StorageProvider`) · Decorator (caching wrapper over a repository) · Builder
(course assembly, ffmpeg HLS command) · Factory (job handler resolution) · Abstract Factory
(notification channel families) · Prototype ("duplicate this course") · Facade
(`CheckoutService`, `PlaybackService`).

**Singleton:** you get it from Nest's DI container. **Never hand-roll one.** Being able to
say _"Singleton is a DI-container concern, not something I implement"_ is itself a good
answer.

---

## 14. Interview-evidence checklist

The project must end up owning these. Fill every number with something you **measured** —
never a guess.

| Evidence                                                                             | Source | Status |
| ------------------------------------------------------------------------------------ | ------ | ------ |
| k6: 1,000 concurrent learners, p95 < 300 ms                                          | 5.1    | ☐      |
| A tuning before/after with real `EXPLAIN ANALYZE` numbers                            | 5.2    | ☐      |
| Docker image size before → after                                                     | 2.1    | ☐      |
| **The trace spanning `checkout → webhook → outbox relay → email sent`** (screenshot) | 2.10   | ☐      |
| 50 concurrent webhook replays → exactly one enrollment                               | 6.2    | ☐      |
| SIGKILL mid-transcode → clean recovery, zero duplicates                              | 6.2    | ☐      |
| `git push` → prod in under 10 min, zero downtime, one-click rollback                 | 2.8    | ☐      |
| Non-enrolled user blocked at the API **and** at the CDN                              | 6.2    | ☐      |
| Executed PITR restore drill, with RTO/RPO                                            | 5.4    | ☐      |
| Worker cost reduction from queue-depth autoscaling + spot                            | 2.9    | ☐      |

### Follow-ups to bait (`PITCH.md`)

| If they ask…                                     | You have…                                                           | Ready |
| ------------------------------------------------ | ------------------------------------------------------------------- | ----- |
| "Why not microservices?"                         | ADR-0001 + the 10x split plan, in order, with breaking points named | ☐     |
| "What if the webhook fires twice?"               | dedupe + state machine + outbox + the 50-replay test                | ☐     |
| "How do you stop someone sharing the video URL?" | three-layer enforcement, 5-minute signed cookies                    | ☐     |
| "How do you scale the workers?"                  | queue depth, not CPU + spot + graceful drain + scale-to-zero        | ☐     |
| "What breaks first at 10x?"                      | entitlement cache invalidation fan-out, and ledger contention       | ☐     |
| "How do you deploy without downtime?"            | expand-contract migrations + blue/green + auto-rollback             | ☐     |
| "How do you know it's healthy?"                  | SLOs, error budgets, burn-rate alerts, runbook per alert            | ☐     |

**Never say:** "I used JWT for auth" · "I added Redis for caching" · "It's scalable" · a
feature list. Lead with the problem, always.
