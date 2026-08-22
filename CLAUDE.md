# Masternova — Working Guidelines

Production-grade EdTech platform. Backend + DevOps weighted portfolio project.
Plan: [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) · Pitch: [`PITCH.md`](./PITCH.md)

Monorepo (pnpm workspaces): `apps/api` (NestJS + Fastify + Prisma), `apps/worker`
(NestJS + BullMQ), `apps/web` (Next.js App Router), `packages/shared` (Zod schemas/types),
`packages/contracts` (module public interfaces).

---

## 0. Prime directive

> **Every backend module must be explainable on a whiteboard in an interview.**

This project is a learning vehicle as much as a product. So the bar for backend code is not
"it works" — it is:

1. **Named responsibility** — you can say in one sentence what this class does and does not do.
2. **Named pattern (when one applies)** — you can name the pattern, the *force* that justified
   it, and the alternative you rejected.
3. **Named seam** — you can point at where a second implementation would plug in.

If you can't say all three about a file you just wrote, the design isn't finished yet.

**Corollary:** never accept generated code you can't explain. If a suggestion introduces a
pattern, it must also state the force. Code you can't defend is worse than no code, because
it will be on your resume.

---

## 1. SOLID — concrete rules, with Masternova examples

| | Rule | In this codebase |
| --- | --- | --- |
| **S** | One reason to change per class | `TranscodeService` transcodes. It does not email, does not enroll, does not touch orders. `OrderService` orchestrates order state; **pricing lives in `PricingService`**, entitlement in `EntitlementService`. |
| **O** | Extend by adding, not editing | A new entitlement rule = **a new `Policy` class**, zero edits to the engine. A new payment gateway = a new adapter, zero edits to `CheckoutService`. If a feature makes you open a `switch`, the design is wrong. |
| **L** | Substitutable implementations | Any `StorageProvider` must work identically for MinIO and S3. **No implementation may throw `NotSupportedError`** — if it must, the interface is wrong, split it. |
| **I** | Small, role-shaped interfaces | Split `CourseReader` / `CourseWriter`. The worker must not depend on an interface carrying HTTP concerns. Prefer three 2-method interfaces over one 6-method interface. |
| **D** | Depend on abstractions | Services inject `PAYMENT_PROVIDER`, never `RazorpayService`. Every swappable dependency is an **interface + `Symbol` injection token**, provided via `{ provide: TOKEN, useClass: Impl }`. |

**Data access always goes through a repository** behind an interface. `PrismaService` calls
must never be scattered across services — that breaks D, makes testing need a database, and
is the single most common reason a "clean architecture" claim falls apart under questioning.

---

## 2. Design pattern map — where each one lives

Build these deliberately. When you implement one, **update the matching note in `../LLD/`**
with the real code as its example — that converts study notes into lived experience, which is
what makes them survive interview pressure.

| Pattern | Where in Masternova | The force that justifies it |
| --- | --- | --- |
| **Strategy** | entitlement policies · payment providers · storage providers · transcode profiles | many interchangeable algorithms, chosen at runtime |
| **Chain of Responsibility** | entitlement engine — each policy returns `ALLOW / DENY / ABSTAIN`, explicit DENY wins | ordered rules, any of which may decide or pass |
| **State** | order state machine · course draft lifecycle · upload session | behaviour depends on lifecycle stage; illegal transitions must be impossible |
| **Builder** | course assembly in the multistep wizard · ffmpeg HLS command construction | complex object built stepwise with validation before it is legal |
| **Factory Method** | job handler resolution by job type in the worker | choose an implementation from a discriminator |
| **Abstract Factory** | notification channel families (email / in-app / future SMS) | related objects created as a consistent set |
| **Prototype** | **"Duplicate this course"** on the instructor dashboard | deep-copy an aggregate cheaply, then mutate |
| **Adapter** | Razorpay → `PaymentProvider` · S3/MinIO → `StorageProvider` · Resend/Brevo → `MailProvider` | third-party API ≠ your domain interface |
| **Decorator** | caching wrapper over a repository · retry/log wrappers around external clients | add behaviour without touching the subject or its callers |
| **Facade** | `CheckoutService` fronting cart + pricing + payment + order · `PlaybackService` fronting entitlement + token + manifest | one coherent entry point over a messy subsystem |
| **Observer / pub-sub** | domain events → **outbox** → handlers (enroll, invoice, email, index) | one cause, many independently-failing effects |
| **Template Method** | `BaseJobProcessor`: `validate → execute → persist → emit` with subclass hooks | fixed skeleton, varying steps |
| **Command** | wizard step edits (undoable) · queue job payloads | operations as first-class objects — queue them, log them, undo them |
| **Specification** | course search/filter predicates, composable with `and` / `or` | business rules combined at runtime without a query-builder explosion |
| **Repository + Unit of Work** | all persistence; outbox rows written in the same transaction as the state change | isolate the domain from the ORM; atomic multi-table effects |

**Singleton:** you get it from Nest's DI container. **Never hand-roll one.** Being able to say
*"Singleton is a DI-container concern, not something I implement"* is itself a good answer.

---

## 3. When NOT to use a pattern

Pattern overuse reads as junior faster than having no patterns at all. Interviewers probe this.

- **No pattern without a named force.** Write the force in a one-line comment above the
  abstraction. If you can't name it, delete the abstraction.
- **One implementation is not a seam.** Only abstract where a second implementation genuinely
  exists or is planned (storage, payments, mail, AI provider, search). Everywhere else, a
  concrete class is the correct design.
- **Prefer composition over inheritance.** Inheritance only for genuine `is-a` with a stable
  contract (`BaseJobProcessor` qualifies; almost nothing else will).
- **No god services and no anemic services.** If a service exceeds ~200 lines or 5 public
  methods, it's holding more than one responsibility — split it.
- **YAGNI beats speculative generality.** Adding a plugin architecture "for later" is a
  liability you will have to defend.

---

## 4. Architecture rules

- **Bounded contexts** are real boundaries: `identity`, `catalog`, `media`, `commerce`,
  `enrollment`, `engagement`, `notification`, `analytics`.
- **No cross-module imports of internals.** A module may only import another module's
  *public interface* from `packages/contracts`. If two modules need each other's internals,
  the boundary is drawn in the wrong place — fix the boundary, don't add the import.
- **Cross-context communication is via domain events + outbox**, not direct service calls,
  wherever the effect can fail independently (enroll, email, search index).
- Keep controllers thin: parse → authorize → delegate → map response. Zero business logic.
- Config: never read `process.env` outside `src/config/`. New env vars go in the Zod schema in
  `env.validation.ts`, exposed via a namespaced `registerAs` factory.
- Validation: shared Zod schemas from `@masternova/shared` via the `@ZodBody(schema)` helper.
  `packages/shared` is the single source of truth for request/response shapes — never
  duplicate a DTO per app.
- Errors: throw domain exceptions from `common/exceptions/` or Nest `HttpException`s; the
  global `AllExceptionsFilter` shapes the response. Never `throw new Error(...)` on a
  request path.
- **Idempotency is a first-class concern.** Any handler reachable from a retry, a webhook, or
  a queue must be idempotent, and must have a test that proves it by running it twice.

### Scaffold the Nest way — always, no exceptions

**Never hand-create a Nest building block that the CLI can generate.** The generator wires
the module graph, applies the naming and file conventions, and updates the parent module's
`imports`/`providers` for you. Hand-written files drift from those conventions immediately,
and the drift is what makes a codebase stop looking like idiomatic NestJS.

```bash
pnpm -F @masternova/api exec nest g module      modules/<name>
pnpm -F @masternova/api exec nest g service     modules/<name>
pnpm -F @masternova/api exec nest g controller  modules/<name>
pnpm -F @masternova/api exec nest g guard       modules/<name>/guards/<name>
pnpm -F @masternova/api exec nest g interceptor common/interceptors/<name>
pnpm -F @masternova/api exec nest g pipe        common/pipes/<name>
pnpm -F @masternova/api exec nest g filter      common/filters/<name>
pnpm -F @masternova/api exec nest g decorator   common/decorators/<name>
pnpm -F @masternova/api exec nest g class       modules/<name>/policies/<name>
# --flat / --no-spec only with a reason; add `-d` to dry-run first
```

The same applies to the worker (`-F @masternova/worker`). Scaffold **first**, then write the
logic into the generated file. Only the things Nest has no generator for — interfaces,
injection-token `Symbol`s, Prisma repositories, domain events — are created by hand, and
they still follow the surrounding folder layout.

Prisma changes go through `prisma migrate dev` — never `db push` outside local dev, never
hand-edit the generated client.

### The order of work for every backend unit

1. `nest g …` to scaffold.
2. Define the **interface + `Symbol` token** before the implementation (§1 D).
3. Write the implementation behind it, and the one-line comment naming **the force**.
4. Unit-test the pattern with no database; integration-test persistence with Testcontainers.
5. Write `docs/lld/<module>.md` — **in the same commit** (§7).
6. Update the matching note in `../LLD/` with this code as its example.

Skipping step 1 is how you end up with a module that works and still reads as junior.

---

## 5. `apps/web` (Next.js)

- Reusable components first: factor UI into small, well-typed components before building a
  page. No copy-pasted markup between screens.
- Page files stay thin — composition + data fetching; logic lives in hooks and components.
- Consume API types from `@masternova/shared`; never redefine request/response shapes client-side.
- Follow App Router conventions: server components by default, `"use client"` only for
  interactive islands (player, wizard, cart).
- The Figma is the source of truth for layout. Extract design tokens once; don't hand-tune
  spacing per screen.

---

## 6. Testing

- **Unit tests target the patterns**: policy chain, state machines, specification composition,
  pricing arithmetic. These are pure and should need no database.
- **Integration tests use Testcontainers** (real Postgres + Redis) — repositories, transactions,
  outbox, idempotency.
- Every idempotent handler gets a **"run it twice / run it 50× concurrently"** test.
- A repository behind an interface means services are tested with a fake, not a mock of Prisma.
  If a service test needs Prisma, you violated D — fix the design, not the test.

---

## 7. Documentation is part of "done"

> **A module is not done when it works. It is done when it works *and* it is documented.**

When you start work on any backend functionality, the documentation is written **in the same
commit as the code** — not in a cleanup pass, not in week 8. Two reasons: a doc written later
is a doc written from memory and therefore wrong, and drawing the sequence diagram is how you
discover the bug you were about to ship.

### 7.1 The docs tree

```
docs/
  hld/
    00-overview.md        system context, actors, C4 L1 (context) + L2 (containers)
    01-architecture.md    container responsibilities, deployment topology, sync vs async edges
    02-data-flows.md      end-to-end flows: signup · upload→playable · checkout→enrolled · playback
    03-capacity.md        back-of-envelope sizing for 100k learners (QPS, storage, bandwidth, cost)
    04-failure-modes.md   what breaks, blast radius, degradation strategy
    05-scaling.md         the 10x split plan + named breaking points
  lld/
    <module>.md           ONE PER MODULE / FUNCTIONALITY — see the template below
  adr/
    NNNN-<slug>.md        one decision per file, numbered, never deleted (superseded instead)
  api/
    openapi.yaml          generated + committed
    conventions.md        error envelope, cursor pagination, versioning, idempotency contract
  db/
    erd.md                entity diagram + relationships
    indexes.md            every non-PK index with the query it serves and its EXPLAIN evidence
    migrations.md         expand-contract policy, rollback notes
  runbooks/
    <alert-name>.md       one per alert: symptom → likely cause → checks → fix → escalation
  slo.md                  SLIs, targets, error budgets, burn-rate alert policy
```

### 7.2 What you changed → what you write

| You did this | You must update |
| --- | --- |
| Added a module or a distinct piece of functionality | **`docs/lld/<module>.md`** — mandatory, no exceptions |
| Added a cross-context flow, a container, or an infra dependency | `docs/hld/01-architecture.md` + `02-data-flows.md` |
| Made a choice where a real alternative existed | `docs/adr/NNNN-<slug>.md` |
| Added or changed an endpoint | `docs/api/openapi.yaml` (+ `conventions.md` if it introduces a rule) |
| Changed the Prisma schema | `docs/db/erd.md` + `indexes.md` (with the EXPLAIN that justifies the index) |
| Added an alert | `docs/runbooks/<alert>.md` |
| Added a user-visible reliability target | `docs/slo.md` |
| Implemented a design pattern | the matching note in **`../LLD/`**, using this code as its example |

### 7.3 Required structure — `docs/lld/<module>.md`

Use this template verbatim every time. **Do not improvise the shape per file** — a fixed
structure is what lets you re-read six of these in twenty minutes the night before an interview.

````markdown
# <Feature> — Low Level Design

> **One-liner:** what this module is responsible for, in a single sentence.

**Module:** `apps/api/src/modules/<x>` · **Status:** draft | built | hardened
**Last updated:** YYYY-MM-DD

## 1. Problem
What are we solving, and for whom. One paragraph.

## 2. Forces
Why this is not trivial. Name them explicitly: concurrency · retries · money ·
multiple actors · partial failure · write volume · external system you don't control.

## 3. Domain model
Entities, their invariants ("an order can never leave PAID without an enrollment"),
and legal states.

## 4. Class design
```mermaid
classDiagram
  ...interfaces, implementations, injection tokens...
```

## 5. Main flow
```mermaid
sequenceDiagram
  ...the happy path, then the interesting failure path...
```

## 6. Patterns used
| Pattern | Where | The force that justified it |

## 7. Alternatives rejected
| Option | Why not |

## 8. Failure modes
| Failure | How it is detected | Behaviour | Recovery |

## 9. Data & indexes
Tables touched, the indexes that serve them, and the transaction boundaries.

## 10. Tests that prove it
Name the specific tests, especially the idempotency / concurrency ones.

## 11. Interview notes — 60-second recall
The compressed version: the problem, the one design decision that mattered,
and the number that proves it works.
````

Section 11 is the highest-value part of the file. Write it last, keep it to genuinely sixty
seconds, and keep it in the same shape as your `LLD/0. Index.md` notes so revision feels familiar.

### 7.4 Rules that keep the docs honest

- **Mermaid, always.** Diagrams live as Mermaid inside the markdown so they diff, review, and
  version. Never a screenshot of a whiteboard, never an image-only diagram.
- **Date every document.** An undated doc rots silently; a stale doc is worse than no doc.
- **Doc and code disagreeing is a bug.** Fix it in the same commit you noticed it.
- **One ADR = one decision.** Superseded ADRs are marked superseded, never deleted — the
  trail of changed decisions is itself the signal.
- **Write the HLD incrementally.** Don't wait for week 8; update `docs/hld/` the week a
  container or a cross-context flow first appears.

### 7.5 Definition of done — backend module checklist

- [ ] Code + unit tests (patterns tested without a database)
- [ ] Integration tests via Testcontainers where persistence is involved
- [ ] Idempotency test if reachable from a retry, a webhook, or a queue
- [ ] `docs/lld/<module>.md` complete, **both diagrams present**
- [ ] `docs/hld/` updated if a container, dependency, or cross-context flow changed
- [ ] ADR written if a real alternative was rejected
- [ ] `docs/api/openapi.yaml` regenerated; `docs/db/` updated if the schema moved
- [ ] Matching pattern note in `../LLD/` updated with this code as its example

---

## 8. Running locally

```bash
docker compose up -d --build     # postgres, redis, minio, mailpit, typesense, otel stack, api, worker
```
Running the API on the host can fail if a native Postgres holds port 5432 — prefer compose
(apps reach `postgres:5432` on the internal network).

---

## 8.5 Use the right tool for the task — skills and generators

The bar is a codebase that is **clean, maintainable, and idiomatic**, not merely working.
That means reaching for the purpose-built tool instead of improvising:

| When the task is… | Use | Not |
| --- | --- | --- |
| A Nest module / service / controller / guard / pipe / filter / interceptor / decorator | **`nest g …`** (§4) | hand-created files |
| A shadcn component | `pnpm dlx shadcn@latest add <component>` | copy-pasted markup |
| A Prisma schema change | `prisma migrate dev` | `db push`, hand-edited client |
| Reviewing a diff before committing | the **`code-review`** skill | eyeballing it |
| Tidying up after a feature lands | the **`simplify`** skill | leaving it |
| Checking the pending branch for security issues | the **`security-review`** skill | hoping |
| Any chart or dashboard (Grafana panels, README graphs, k6 result plots) | the **`dataviz`** skill | ad-hoc chart code |
| Designing a screen with no Figma source | the **`design`** skill | guessing at layout |
| Anything touching the Claude API or model IDs | the **`claude-api`** skill | memory |
| Driving the running app in a browser to verify a change | the **`run`** / **`claude-in-chrome`** skills | assuming it works |

**The general rule:** before writing something by hand, check whether a generator, a skill,
or an official CLI already does it. Bespoke work is for the parts that are genuinely
specific to Masternova — the policy chain, the outbox, the ledger — not for scaffolding,
boilerplate, or review.

**And the standing quality bar, restated because it is the whole point of this project
(§0):** every unit of backend work must satisfy SOLID (§1), name its pattern *and the force
that justified it* (§2), avoid patterns that have no force (§3), respect the module
boundaries (§4), be tested at the level that proves the pattern (§6), and ship its
documentation in the same commit (§7). A task is not finished until all of that is true —
"it works" is the start of the checklist, not the end of it.

---

## 9. Commits

- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- **Never add a `Co-Authored-By` trailer or any Claude/AI attribution.** This is a personal
  repo; the history must show only the user.
- Commit at a working-increment granularity. The commit history is part of the portfolio —
  a reviewer reads it to see how you work.
