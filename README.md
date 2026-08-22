# Masternova

Production-grade EdTech platform — a backend + DevOps portfolio project.

> **The one sentence:** it's an EdTech platform, but the real project is the backend problem
> underneath it — **how do you sell access to a video, and then make sure only the people who
> paid can watch it**, without ever double-charging anyone, and without melting under load?

Three sub-problems fall out of that, and they are the whole project:

1. Get the video ready to stream — **ingest + transcode pipeline**
2. Take the money exactly once — **checkout, idempotency, outbox**
3. Decide who's allowed to watch — **entitlement engine**

## Status

**Phase 0 — Foundation.** See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the full roadmap and
live task tracker.

## Architecture

A **modular monolith plus a separate worker fleet** on Postgres, Redis and S3 — a deliberate
choice, recorded in [ADR-0001](./docs/adr/0001-modular-monolith.md) along with the 10x split
plan and the named breaking points.

| Workspace | What it is |
| --- | --- |
| `apps/api` | NestJS 11 + Fastify + Prisma — hard module boundaries per bounded context |
| `apps/worker` | NestJS standalone context + BullMQ — separate deployable, different resource profile |
| `apps/web` | Next.js 15 App Router |
| `packages/shared` | Zod schemas + types — the single source of truth for request/response shapes |
| `packages/contracts` | Module public interfaces — the only surface one context sees of another |

## Running locally

```bash
docker compose up -d --build     # postgres(pgvector), redis, minio, mailpit, api, worker, web
```

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:3001/api |
| Mailpit (every dev email lands here) | http://localhost:8025 |
| MinIO console | http://localhost:9001 |

Running the API on the host can fail if a native Postgres holds port 5432 — prefer compose;
the apps reach `postgres:5432` on the internal network.

```bash
pnpm lint && pnpm typecheck && pnpm -r test:unit   # fast loop
pnpm --filter @masternova/api test:int                # real Postgres + Redis via Testcontainers
```

## Documentation

Documentation is part of "done" — a module ships its docs in the same commit as its code.

| Path | Holds |
| --- | --- |
| [`docs/hld/`](./docs/hld) | C4 context + containers, capacity, failure modes, scaling |
| [`docs/lld/`](./docs/lld) | one per module — [template](./docs/lld/_TEMPLATE.md) |
| [`docs/adr/`](./docs/adr) | one decision per file, numbered, never deleted |
| [`docs/api/`](./docs/api) | OpenAPI spec + conventions |
| [`docs/db/`](./docs/db) | ERD, index rationale with EXPLAIN evidence |
| [`docs/runbooks/`](./docs/runbooks) | one per alert |

Working guidelines: [`CLAUDE.md`](./CLAUDE.md) · Plan: [`PROJECT_PLAN.md`](./PROJECT_PLAN.md)
· How to explain it: [`PITCH.md`](./PITCH.md)
