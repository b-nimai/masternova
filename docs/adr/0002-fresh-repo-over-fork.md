# ADR-0002 — Fresh repository over forking Loom Lite AI

**Status:** accepted · **Date:** 2026-08-22 · **Deciders:** Nimai

## Context

Masternova replaces Loom Lite AI as the portfolio project. `PROJECT_PLAN.md` §11 recommends
forking Loom rather than starting fresh, on the grounds that the inherited May–July commit
history makes the repo read as six months of sustained work instead of an eight-week sprint.

An inventory of Loom on 2026-08-22 measured what would actually be inherited:

- **10 commits** (2026-05-31 → 2026-07-03), ~60 source files
- **Zero** tests, **zero** ESLint config, **zero** CI, **zero** Prisma migrations, **zero**
  production Dockerfiles
- The worker's only processor logs the job and returns — there is no transcoding
- The domain (`Video` / `Transcript` / `View`, the browser recorder) is Loom-specific and
  would be deleted wholesale

So the inheritance is real plumbing and no domain, carried on a history whose commit
messages describe a different product.

## Decision

**Start a fresh repository at `github.com/b-nimai/Masternova.git`, and hand-copy the parts of
Loom that are genuinely good.** The copy list is `BUILD_PLAN.md` §5, path by path.

## Consequences

**Positive.** The commit history describes Masternova and only Masternova — a reviewer reading
it sees how this system was built, which `CLAUDE.md` §9 treats as part of the portfolio. No
dead `Video`/`Transcript` models or recorder components to explain away. The seven latent
defects found during the inventory (no ESLint, tsconfigs not extending the base, `db push`
instead of migrations, no MinIO CORS sidecar, pgvector never enabled, worker without Prisma,
an unused `@fastify/cookie` dependency) get fixed at the moment of copying rather than
inherited and rediscovered later.

**Negative.** The "six months of sustained work" signal is lost. Roughly 3 hours are spent
re-establishing scaffolding that a fork would have provided free.

## Why the negative is acceptable

The six-month signal was never load-bearing. A reviewer who opens the history sees ten
commits about a screen recorder, followed by a rename — which reads *worse* than an honest
short history of a well-built system, because it invites the question of what the first ten
commits have to do with the project being discussed.

Loom Lite AI remains on GitHub, unmodified, as its own project. Nothing is destroyed by this
decision; the history still exists where it belongs.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Fork Loom, `git mv` into shape | Inherits the defect list silently, and every future `git log` on a file walks back into Loom's domain. |
| Fresh repo, build everything from scratch | Discards the genuinely non-obvious work — the dual-S3Client MinIO presigning trick and the 114-line parallel multipart uploader especially — for no gain. Roughly a week of re-solving solved problems. |
| Fork, then `git checkout --orphan` a new root | The worst of both: a repo that *contains* the old history but does not show it, which is confusing rather than clean. |
