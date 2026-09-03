# Catalog indexes — the queries, and the `EXPLAIN` that justifies each one

> **One-liner:** every non-PK index on `Course`, the exact query it exists for, what that
> query cost without it, what it costs with it, and — for three of them — why they were
> measured and then thrown away.

**Tables:** `Course`, `Section`, `Lecture`, `Category` · **Task:** 1.4
**Last updated:** 2026-08-22

An index without the query that justifies it is cargo cult (`docs/db/README.md`). So this
file is not a list of indexes. It is a list of **(index, query, before, after, verdict)**,
and it deliberately keeps the losers: an index that failed to beat a sequential scan, with
its numbers, is more credible than six indexes that all "helped".

---

## 1. Environment

A latency number without its environment is not evidence.

|                  |                                                                               |
| ---------------- | ----------------------------------------------------------------------------- |
| Image            | `pgvector/pgvector:pg16` (docker compose service `postgres`)                  |
| Server           | PostgreSQL **16.15** on Debian 12, x86-64                                     |
| `shared_buffers` | **128 MB** (image default — not tuned)                                        |
| `work_mem`       | 4 MB · `effective_cache_size` 4 GB · `random_page_cost` 4 · `seq_page_cost` 1 |
| `jit`            | on · `max_parallel_workers_per_gather` 2                                      |
| Client           | `psql` inside the container, so no network between client and server          |

**The single most important caveat:** the `Course` heap is **1,909 pages / 15 MB**, and the
whole database is smaller than `shared_buffers`. Every measurement below is therefore a
**warm-cache** measurement — `Shared Read Blocks` is ~0 almost everywhere and `I/O Read
Time` is zero. The absolute milliseconds are consequently optimistic and would be far worse
on a table that does not fit in RAM.

What is _not_ optimistic, and is what this document actually rests on, is the **buffer
count**: 1,915 buffers touched versus 23 is a 83× reduction in work that holds regardless
of whether those pages were in memory or on a disk. Read the buffers column first and the
milliseconds second.

---

## 2. The dataset

Produced by `pnpm -F @masternova/db run seed:catalog`
(`packages/db/prisma/seed/catalog.seed.ts`), which is **deterministic**: a `mulberry32`
PRNG seeded with the constant `SEED = 0x4d415354`, self-generated cuid-shaped ids, and no
`Math.random` / `Date.now` anywhere. Re-running it reproduces this table byte for byte,
which is what makes the numbers below re-checkable rather than anecdotal.

| Table                | Rows                            | Heap   | Total (heap + indexes, before this work) |
| -------------------- | ------------------------------- | ------ | ---------------------------------------- |
| `Course`             | 10,000                          | 15 MB  | 16 MB                                    |
| `Lecture`            | 24,000                          | 8.2 MB | 13 MB                                    |
| `Section`            | 3,000                           | 720 kB | 1.4 MB                                   |
| `User` (instructors) | 200                             | —      | —                                        |
| `Category`           | 72 (12 roots × 5 children + 12) | —      | —                                        |

**Distribution, which matters far more than the count.** A seed where every course is
`PUBLISHED` and evenly spread across categories flatters every index, because every
predicate has the same selectivity and the planner never faces an interesting decision.

| Facet          | Shape                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `status`       | 7,786 PUBLISHED / 1,529 DRAFT / 383 IN_REVIEW / 302 ARCHIVED                                       |
| `categoryId`   | Zipf s=1.0 over 60 subcategories. Top 3 hold **38.9%** (2,149 / 1,056 / 686); coldest holds **24** |
| `instructorId` | Zipf s=0.3 over 200 instructors. Busiest owns **175** courses; median ~30                          |
| `title`        | `ILIKE '%kubernetes%'` matches **125** rows (1.25%) — a number a human would believe               |
| `priceMinor`   | ladder 0 / 499 / 999 / 1499 / 1999 / 3499 (₹), weights 8 / 22 / 30 / 20 / 13 / 7                   |
| structure      | 500 courses have real sections and lectures (6 × 8); the other 9,500 carry rollups only            |

`ANALYZE` runs as the last statement of the seed. Measuring before autovacuum has produced
statistics gives a "before" the planner would never reproduce, which is not a before — it is
noise.

---

## 3. Method

For every query:

```sql
SET track_io_timing = on;
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) <query>;
```

run **three times**, reporting the **median** execution time and the plan from that median
run. Recorded per query: planning time, execution time, actual rows, and shared buffers
hit/read — not just milliseconds. Page size is **21** everywhere, which is `limit + 1`: the
extra row is how keyset pagination learns there is a next page without a second count query.

The "after" column was produced by creating the six candidate indexes **by hand in psql**,
`ANALYZE`-ing, re-measuring, and then **dropping them again** so the database matches the
migration history and the migration that ships them produces a clean diff. All six were
present simultaneously, which is the realistic condition: it lets the planner reject one in
favour of another, and that rejection is itself a finding (§6.4).

---

## 4. The index set

Declared on `Course` as `@@index` lines. Sizes and build times are from this dataset.

| #   | Index                                    | Size   | Build | Exists for                                                        |
| --- | ---------------------------------------- | ------ | ----- | ----------------------------------------------------------------- |
| I1  | `(status, publishedAt DESC, id DESC)`    | 656 kB | 19 ms | Q1, Q2 — the default catalog list and its keyset pages            |
| I2  | `(status, categoryId, publishedAt DESC)` | 496 kB | 16 ms | Q3 — category browse                                              |
| I3  | `(status, ratingAverage DESC, id DESC)`  | 592 kB | 22 ms | Q8 — "highest rated" sort                                         |
| I4  | `(status, priceMinor)`                   | 88 kB  | 9 ms  | Q4 — price band facet · **rejected, see §6.4**                    |
| I5  | `(instructorId, status, updatedAt DESC)` | 552 kB | 21 ms | Q6 — instructor dashboard · **ships in a changed form, see §6.6** |
| I6  | `GIN (title gin_trgm_ops)`               | 776 kB | 70 ms | Q5 — interim substring search until Typesense (task 1.13)         |

Total index cost of the winners: about 2.5 MB against a 15 MB heap. Cheap. Build times are
two orders of magnitude below the point where `CREATE INDEX CONCURRENTLY` becomes a
conversation — at 10k rows it is not one, at 10M it will be, and `docs/db/migrations.md`
owns that when it becomes true.

Pre-existing indexes, created by migration `20260822171623_catalog` and not touched here:
`Course_slug_key`, `Section_courseId_position(_key)`, `Lecture_sectionId_position(_key)`,
`Category_slug_key`, `Category_parentId_idx`.

---

## 5. Results

Median of 3. `buffers` is `Shared Hit + Shared Read` at the root node.

| Query      | What it is                                  | Before (ms) | Before buffers | After (ms) | After buffers |       Δ | Index used                       | Verdict              |
| ---------- | ------------------------------------------- | ----------: | -------------: | ---------: | ------------: | ------: | -------------------------------- | -------------------- |
| **Q1**     | catalog list, first page                    |       7.838 |          1,915 |  **0.105** |            23 | **75×** | I1                               | ✅ ship              |
| **Q2a**    | keyset deep page, `OR` form                 |       6.017 |          1,915 |      0.964 |         1,032 |    6.2× | I1                               | ⚠️ see §6.2          |
| **Q2b**    | same page by `OFFSET 1000`                  |       6.966 |          1,915 |      1.133 |         1,032 |    6.1× | I1                               | ❌ pattern rejected  |
| **Q2c**    | same page, row-comparison form              |       5.748 |          1,915 |  **0.121** |            24 | **47×** | I1                               | ✅ the form to write |
| **Q3hot**  | browse hot category (1,667 pub.)            |       4.708 |          1,915 |  **0.270** |            54 |     17× | I2                               | ✅ ship              |
| **Q3cold** | browse cold category (17 pub.)              |       4.189 |          1,915 |  **0.159** |            28 |     26× | I2                               | ✅ ship              |
| **Q4**     | price band + level facet                    |       4.585 |          1,915 |      0.297 |            84 |     15× | **I1, not I4**                   | ❌ I4 rejected       |
| **Q5**     | `title ILIKE '%kubernetes%'`                |       9.833 |          1,915 |      2.527 |         1,918 |    3.9× | **I1, not I6**                   | ⚠️ see §6.5          |
| **Q5′**    | same, trigram path forced                   |       9.833 |          1,915 |  **0.813** |           119 | **12×** | I6                               | ✅ ship I6           |
| **Q6**     | instructor dashboard                        |       4.424 |          1,912 |      0.605 |           164 |    7.3× | I5                               | ⚠️ see §6.6          |
| **Q6′**    | same, with `(instructorId, updatedAt DESC)` |       4.424 |          1,912 |  **0.108** |            21 | **41×** | I5′                              | ✅ ship I5′          |
| **Q7a**    | course by slug                              |       0.080 |              3 |      0.087 |             3 |       — | `Course_slug_key`                | already served       |
| **Q7b**    | sections by courseId                        |       0.077 |              6 |      0.089 |             6 |       — | `Section_courseId_position_key`  | already served       |
| **Q7c**    | lectures by `sectionId = ANY`               |       0.168 |             20 |      0.194 |            20 |       — | `Lecture_sectionId_position_key` | already served       |
| **Q8**     | highest rated                               |       6.814 |          1,915 |  **0.102** |            23 | **67×** | I3                               | ✅ ship              |

Every "before" plan is the same three nodes — `Limit → Sort → Seq Scan` over all 1,909 heap
pages — because migration `20260822171623_catalog` deliberately shipped **no** secondary
index on `Course`. That absence is what makes the before column honest: it is a real
measurement of the real schema at a real point in its history, not a simulation produced by
turning `enable_indexscan` off.

The Q7 rows are within run-to-run noise in both directions, which is the correct result:
the detail page was already fully served by the unique constraints the catalog migration
created, and nothing here needed to change. Recording that is the point — an unchanged
number is evidence that an index was **not** needed.

---

## 6. Per query

### 6.1 Q1 — the default catalog list · index **I1** ✅

```sql
SELECT id, slug, title, subtitle, "priceMinor", "listPriceMinor", currency, level,
       "ratingAverage", "ratingCount", "lectureCount", "totalDurationSeconds",
       "thumbnailKey", "instructorId", "categoryId", "publishedAt"
FROM "Course"
WHERE status = 'PUBLISHED'
ORDER BY "publishedAt" DESC, id DESC
LIMIT 21;
```

|           | Before                    | After                                                       |
| --------- | ------------------------- | ----------------------------------------------------------- |
| Plan      | `Limit → Sort → Seq Scan` | `Limit → Index Scan using Course_status_publishedAt_id_idx` |
| Execution | 7.838 ms                  | **0.105 ms**                                                |
| Planning  | 0.401 ms                  | 0.683 ms                                                    |
| Buffers   | 1,915 hit                 | 23 hit                                                      |

Before, Postgres reads all 10,000 rows, sorts 7,786 of them, and returns 21 — it does
99.7% of its work to throw it away. After, the index is already in `(publishedAt DESC, id
DESC)` order within the `status = 'PUBLISHED'` range, the `Sort` node disappears entirely,
and the scan stops after 21 index entries.

Note the planning time went **up**, from 0.40 ms to 0.68 ms. That is real and it is the
price of giving the planner six indexes to consider. It is worth paying here (0.28 ms of
planning to save 7.7 ms of execution) and it is the reason §6.4 rejects an index that buys
nothing: an unused index is not free, it costs planning time on every query against the
table, plus write amplification on every insert and update.

`id DESC` is in the sort key and in the index for the same reason: `publishedAt` is not
unique, and a paginated sort whose key is not unique will duplicate and skip rows across
pages. The tiebreak is not decoration.

### 6.2 Q2 — deep pagination: keyset vs offset, and the form of the keyset

This is the evidence behind **ADR-0015 (keyset over offset)**, and the result is more
interesting than the ADR's title suggests.

```sql
-- Q2a  keyset, OR form
WHERE status = 'PUBLISHED'
  AND ("publishedAt" <  TIMESTAMP '2026-05-07 08:03:02'
    OR ("publishedAt" = TIMESTAMP '2026-05-07 08:03:02' AND id < 'cfvzcv24ukf2710z3qx46iu11'))
ORDER BY "publishedAt" DESC, id DESC LIMIT 21;

-- Q2b  offset
WHERE status = 'PUBLISHED'
ORDER BY "publishedAt" DESC, id DESC OFFSET 1000 LIMIT 21;

-- Q2c  keyset, row-comparison form
WHERE status = 'PUBLISHED'
  AND ("publishedAt", id) < (TIMESTAMP '2026-05-07 08:03:02', 'cfvzcv24ukf2710z3qx46iu11')
ORDER BY "publishedAt" DESC, id DESC LIMIT 21;
```

|                   |                 Q2a `OR` |             Q2b `OFFSET` |    Q2c row-comparison |
| ----------------- | -----------------------: | -----------------------: | --------------------: |
| Before (no index) |     6.017 ms / 1,915 buf |     6.966 ms / 1,915 buf |  5.748 ms / 1,915 buf |
| After (I1)        | 0.964 ms / **1,032 buf** | 1.133 ms / **1,032 buf** | **0.121 ms / 24 buf** |

**Keyset written as an `OR` is barely better than `OFFSET`** — 0.964 ms against 1.133 ms,
and both touch the same ~1,032 buffers. That is not the result the pattern promises, and
the plan says why: Postgres cannot turn a disjunction into an index **start** condition, so
it begins at the top of the `PUBLISHED` range and walks 1,000 entries it will discard,
exactly like `OFFSET` does. The clever cursor bought nothing.

The **row-comparison** form `("publishedAt", id) < (…, …)` is a single multi-column
inequality, which _is_ a start condition. The scan begins at the cursor: 24 buffers, 0.121
ms, **8× faster than the `OR` form and 9× faster than `OFFSET`** — and, unlike either, its
cost does not grow with page depth.

> **The rule this produces, for `docs/api/conventions.md`:** keyset pagination is only a
> keyset if the predicate is a row comparison. Prisma's fluent API cannot express `(a, b) <
(x, y)`, so the catalog list repository builds this clause with `Prisma.sql`. That is not
> an optimisation, it is the difference between having the pattern and having its costume.

### 6.3 Q3 — category browse, hot and cold · index **I2** ✅

```sql
WHERE status = 'PUBLISHED' AND "categoryId" = $1
ORDER BY "publishedAt" DESC, id DESC LIMIT 21;
```

| Category                                 | Published rows |   Before |    After | Buffers after |
| ---------------------------------------- | -------------: | -------: | -------: | ------------: |
| `databases-search-engines` (hot)         |          1,667 | 4.708 ms | 0.270 ms |            54 |
| `web-development-web-performance` (cold) |             17 | 4.189 ms | 0.159 ms |            28 |

**The honest negative result.** The seed's Zipf skew was built specifically so this query
would flip between an index scan and a sequential scan depending on which category id you
pass. **It does not flip.** Both use I2. The reason is `LIMIT 21`: no matter how many rows
match, the plan stops after 21, so selectivity barely enters the cost model.

Selectivity _does_ decide the plan once the `LIMIT` is gone. The facet-count query — the
same predicate, aggregating instead of paginating — shows the spread the skew was for:

|      | Rows matched | Plan                                   | Execution | Buffers |
| ---- | -----------: | -------------------------------------- | --------: | ------: |
| hot  |        1,667 | Index **Only** Scan, `Heap Fetches: 0` |  0.298 ms |      15 |
| cold |           17 | Index **Only** Scan, `Heap Fetches: 0` |  0.035 ms |       3 |

Still no seq scan — an 8.5× cost spread from a 98× row spread, but the same plan shape. The
flip needs a table that does not fit in `shared_buffers`; at 15 MB, an index scan is never
the wrong answer. **That is the finding, and it is worth more than the one I expected:** at
10k rows the planner's choices are not interesting, so this document's value is the
buffer-count deltas and the `Sort`-node removals, not a plan flip that a bigger table would
have produced. `docs/hld/05-scaling.md` inherits the question of where the flip actually
occurs.

One real defect surfaced here. The plan is:

```
Limit → Incremental Sort → Index Scan using Course_status_categoryId_publishedAt_idx
```

The `Incremental Sort` is there because **I2 ends at `publishedAt` and the query sorts by
`(publishedAt DESC, id DESC)`**. Postgres gets the leading key from the index and sorts each
tie group by `id` itself. It is cheap here because `publishedAt` ties are rare, but it is
avoidable: **I2 should be `(status, categoryId, publishedAt DESC, id DESC)`**, matching I1's
shape. Flagged for the migration.

### 6.4 Q4 — price band + level facet · index **I4** ❌ **rejected**

```sql
WHERE status = 'PUBLISHED' AND "priceMinor" BETWEEN 0 AND 99900 AND level = 'BEGINNER'
ORDER BY "publishedAt" DESC, id DESC LIMIT 21;
```

Matches **1,689 of 10,000 rows — 16.9%**. That is the whole problem: a predicate that keeps
one row in six is not selective, and an index exists to be selective.

| Scenario                |    Execution | Buffers | Plan                                                                 |
| ----------------------- | -----------: | ------: | -------------------------------------------------------------------- |
| No index (before)       |     4.585 ms |   1,915 | `Limit → Sort → Seq Scan`                                            |
| **I4 alone**            |     3.000 ms |     963 | `Limit → Sort → Bitmap Heap Scan using Course_status_priceMinor_idx` |
| All six indexes present | **0.297 ms** |      84 | `Limit → Index Scan using Course_status_publishedAt_id_idx`          |

Read the third row carefully: **with every candidate available, the planner did not choose
I4.** It chose I1 — the ordering index — and applied the price and level predicates as a
filter, because walking `publishedAt DESC` and discarding five rows in six still reaches 21
matches after ~120 index entries, and that beats building a 1,689-row bitmap and then
sorting it.

I4 in isolation _is_ better than nothing (4.585 → 3.000 ms). It is 10× worse than an index
we are shipping anyway. An index the planner will never pick is pure cost: 88 kB, a write on
every course insert and update, and planning time on every query against the table (§6.1
measured that at ~0.28 ms across all six). **Not shipped.**

The rule generalised: **a facet is not an index.** Price and level are low-cardinality
filters over an already-ordered scan; they belong in the `WHERE` clause of a query that gets
its ordering from I1. When faceting genuinely needs to be fast — counts across all bands at
once, not one band paginated — that is Typesense's job in task 1.13, not Postgres's.

### 6.5 Q5 — substring title search · index **I6** ✅ ship, ⚠️ but the planner needs help

```sql
WHERE status = 'PUBLISHED' AND title ILIKE '%kubernetes%'
ORDER BY "publishedAt" DESC, id DESC LIMIT 21;
```

| Scenario                                       |    Execution |   Buffers | Plan                                                                                            |
| ---------------------------------------------- | -----------: | --------: | ----------------------------------------------------------------------------------------------- |
| No index (before)                              |     9.833 ms |     1,915 | `Limit → Sort → Seq Scan`                                                                       |
| All six present, planner's choice              |     2.527 ms | **1,918** | `Limit → Index Scan using Course_status_publishedAt_id_idx`, `Filter: title ~~* '%kubernetes%'` |
| Trigram path forced (`enable_indexscan = off`) | **0.813 ms** |   **119** | `Limit → Sort → Bitmap Heap Scan → BitmapAnd(Course_title_idx, …)`                              |

The GIN trigram index is a **12× win over the baseline** and a **3× win over the plan the
planner actually chooses** — and it does not choose it. The `Rows Removed by Filter: 1881`
line explains the bet: it estimates 209 matching rows (actual 125), reasons that walking
`publishedAt DESC` will hit 21 of them soon enough, and gets it roughly right while touching
**more buffers than the sequential scan it replaced** (1,918 vs 1,915). The index scan
"wins" only by being able to stop early.

That bet gets worse as the term gets rarer, because the scan has to walk further before it
finds 21 matches. The mitigation is in the query, not the index:

> When a search term is present, the catalog list orders by **relevance
> (`similarity(title, $q)`)**, not by `publishedAt`. Removing the recency `ORDER BY` removes
> the ordering index from contention, and the planner then picks the trigram index on its
> own. A "newest first" sort combined with a rare substring filter is the shape that traps
> it, and the product does not actually need that combination — someone who types a query
> wants matches, not a chronology.

This whole path is **interim**. Task 1.13 moves search to Typesense; I6 exists so that
`GET /courses?q=` is not a sequential scan in the eight weeks before it lands, and the ADR
covering that hand-off should cite the 0.813 ms / 119 buffers number as the bar Typesense
has to clear. Note `pg_trgm` is already enabled by the catalog migration, so I6 costs one
`@@index` line and nothing else.

### 6.6 Q6 — instructor dashboard · **I5 ships as `(instructorId, updatedAt DESC)`**

```sql
WHERE "instructorId" = $1 ORDER BY "updatedAt" DESC LIMIT 21;
```

175 courses for the busiest instructor.

| Index                                    |    Execution | Buffers | Plan                              |
| ---------------------------------------- | -----------: | ------: | --------------------------------- |
| none (before)                            |     4.424 ms |   1,912 | `Limit → Sort → Seq Scan`         |
| `(instructorId, status, updatedAt DESC)` |     0.605 ms |     164 | `Limit → Sort → Bitmap Heap Scan` |
| **`(instructorId, updatedAt DESC)`**     | **0.108 ms** |  **21** | `Limit → Index Scan`              |

The three-column index **cannot deliver the ordering** this query asks for. `status` sits
between the equality column and the sort column, and the query has no `status` predicate —
the default dashboard tab shows every course an instructor owns, drafts included — so
Postgres can only use the `instructorId` prefix, then bitmap, then sort all 175 rows. Drop
the middle column and the index delivers rows already in `updatedAt DESC` order: **5.6×
faster, 8× fewer buffers, and no `Sort` node at all.**

The counter-case is real and was measured. On a filtered tab (`status = 'DRAFT'`):

| Index                                    |    Execution | Buffers |
| ---------------------------------------- | -----------: | ------: |
| `(instructorId, updatedAt DESC)`         |     0.415 ms |     118 |
| `(instructorId, status, updatedAt DESC)` | **0.096 ms** |      23 |

So neither dominates, and the tiebreak is about **how each one degrades**, not about
today's sub-millisecond numbers:

- With the two-column index, the filtered tab scans in `updatedAt` order and discards
  non-matches. Its cost is bounded by `1 / selectivity` — status has four values and the
  smallest is 3% of the table, so the worst case is a small constant factor.
- With the three-column index, the unfiltered tab must fetch **all N** of an instructor's
  courses and sort them. That is unbounded: an instructor with 2,000 courses sorts 2,000
  rows on the most-visited screen in the dashboard.

**A bounded worst case beats an unbounded one**, and the unbounded case sits on the default
tab. Ship `(instructorId, updatedAt DESC)`.

### 6.7 Q7 — course detail · already served, nothing added ✅

```sql
SELECT … FROM "Course"  WHERE slug = $1;                                   -- 0.087 ms, 3 buffers
SELECT … FROM "Section" WHERE "courseId" = $1 ORDER BY position;           -- 0.089 ms, 6 buffers
SELECT … FROM "Lecture" WHERE "sectionId" = ANY($1) ORDER BY "sectionId", position;
                                                                            -- 0.194 ms, 20 buffers
```

Three statements, 0.37 ms in total, 29 buffers, for a full course page with 6 sections and
48 lectures. All three are served by indexes migration `20260822171623_catalog` already
created — `Course_slug_key`, `Section_courseId_position_key`,
`Lecture_sectionId_position_key` — and the before/after numbers are identical within noise.

`sectionId = ANY(...)` rather than a join is deliberate: the aggregate is loaded as a course
plus its sections plus their lectures, which is two round trips with a bounded fan-out, not
a join that returns the course's columns 48 times. It is also exactly the shape Prisma emits
for a nested `include`, so the ORM and the hand-written path measure the same.

### 6.8 Q8 — highest rated · index **I3** ✅

```sql
WHERE status = 'PUBLISHED' ORDER BY "ratingAverage" DESC, id DESC LIMIT 21;
```

|           | Before                    | After                                                         |
| --------- | ------------------------- | ------------------------------------------------------------- |
| Plan      | `Limit → Sort → Seq Scan` | `Limit → Index Scan using Course_status_ratingAverage_id_idx` |
| Execution | 6.814 ms                  | **0.102 ms**                                                  |
| Buffers   | 1,915                     | 23                                                            |

**67×.** This is the payoff for the denormalised `ratingAverage` column on `Course`: the
same sort computed as an `AVG` over a reviews table would be a join plus a
`GroupAggregate` plus a sort with no ordering index available to rescue it, on every catalog
page load. The rollup is what makes the ordering indexable at all. Task 1.14 owes the
reconciliation job that proves the column never drifts from the reviews it summarises —
this number is why that job is worth writing.

---

## 7. Measured and rejected

| Candidate                                                            | Number                                                                                              | Why it is not shipped                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **I4** `(status, priceMinor)`                                        | Q4: 3.000 ms alone vs **0.297 ms** via I1; never chosen when I1 exists                              | A 16.9%-selective facet is not an index. Dominated by an index we ship anyway, and it would cost writes and planning time forever. §6.4 |
| **Partial** `(publishedAt DESC, id DESC) WHERE status = 'PUBLISHED'` | Q1: **0.102 ms / 23 buffers** vs I1's 0.105 ms / 23 — identical. Index 464 kB vs I1's 656 kB (−29%) | See below                                                                                                                               |
| **I5 as three columns** `(instructorId, status, updatedAt DESC)`     | Q6: 0.605 ms / 164 buffers vs **0.108 ms / 21** for the two-column form                             | Unbounded sort on the default dashboard tab. §6.6                                                                                       |

### Why the partial index is not shipped, despite being smaller

The idea is sound: 78% of courses are `PUBLISHED`, and the public list only ever reads
those, so an index that omits the other 2,214 rows is 29% smaller and skips 2,214 index
writes' worth of maintenance. It measured **identically** to I1 on Q1 (0.102 vs 0.105 ms,
same 23 buffers) — the `status` column is the first key of I1, so the planner was already
jumping straight to the `PUBLISHED` range and the partial index saves it a comparison it was
not spending anything on. It also, obviously, cannot serve any query that looks at a
non-`PUBLISHED` course, which the instructor dashboard and the admin review queue both do.

The decisive reason is not performance, it is **drift**:

> **Prisma cannot declare a partial index.** There is no `where:` argument on `@@index`. The
> index would have to live as hand-written SQL inside a migration file — and because it is
> absent from `schema.prisma`, the _next_ `prisma migrate dev` would see it in the database,
> not in the schema, and generate a `DROP INDEX` for it as drift. It would silently
> disappear on somebody's next model change, and nobody would notice until a p99 alert
> fired.

An index that the tooling will delete behind your back is worse than no index, because it
makes the schema and the database disagree — and `CLAUDE.md` §7.4 calls a doc that disagrees
with the code a bug. Same rule, one layer down. Measured, recorded, dropped.

The same reasoning is why I3 is `(status, ratingAverage DESC, id DESC)` rather than a
partial index on published courses only: leading with `status` gets the same range-jumping
behaviour, in a form Prisma can declare.

---

## 7.5 Indexes added by task 1.5, and why they carry no EXPLAIN

Two of the three are **constraints, not performance work**, and the third serves a query
that cannot be slow by construction. Measuring them against the 10k seed would produce
numbers that prove nothing, and a fabricated before/after is worse than an honest absence.

| Index                                       | What it is for                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Section(courseId, position)` **unique**    | The ordering invariant, already present since 1.4. It is why a reorder has to park rows on negative positions before settling them — Postgres checks it per statement and Prisma cannot declare DEFERRABLE.                                                                                            |
| `Lecture(sectionId, position)` **unique**   | The same, one level down.                                                                                                                                                                                                                                                                              |
| `CourseEdit(courseId, undoneAt, version ⌄)` | The only query against the table: the top of one course's undo stack. Bounded by the edits made to a single course, and read one row at a time with `LIMIT 1` — a table scan here would never be the bottleneck, and the index exists so it stays that way as a long-lived course accumulates history. |

`CourseEdit` will need a retention policy long before it needs a second index: the stack is
only ever read from the top, so rows below the most recent undone edit are audit trail, not
working set. Not built now — there is no volume to justify it, and YAGNI beats a cleanup job
nobody has measured the need for.

## 7.6 Indexes added by task 1.6, and why they carry no EXPLAIN

Same honesty as §7.5. Media has no seeded corpus and, more importantly, **no query here can
be slow by construction** — every read is either by primary key or bounded by one user's
uploads. Numbers against an empty table would prove nothing.

| Index                               | What it is for                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Asset(storageKey)` **unique**      | A constraint, not performance work. The key is identity: two assets sharing one is a bug that would have them overwrite each other's bytes, so the database refuses it rather than the code remembering to.                                              |
| `UploadSession(assetId)` **unique** | One session per asset, enforced where it cannot be forgotten. It is also what makes the `include: { asset: true }` read a single index lookup.                                                                                                           |
| `UploadSession(status, expiresAt)`  | The reaper's queue: `status IN (CREATED, UPLOADING) AND expiresAt < now() ORDER BY expiresAt LIMIT 50`. The leading equality plus the range on the second column is exactly what a composite serves, and the `ORDER BY` comes out of the index for free. |
| `Asset(ownerId, createdAt ⌄)`       | The instructor's media library, newest first — the same shape as the catalog's instructor listing.                                                                                                                                                       |
| `Asset(status)`                     | Sweeping assets whose upload never finished. Low-cardinality and therefore a poor index in isolation; it earns its place only because `PENDING`/`FAILED` are a small minority of a table dominated by `READY`.                                           |

**The one to watch.** `Asset(status)` is the kind of index §7 rejected for catalog — a
three-value column is not selective. It is kept here on a different argument: the sweep asks
for the _rare_ values, and the planner can use it precisely because `READY` dominates. If
that stops being true the index stops being used, and the honest thing will be to drop it
rather than defend it.

## 7.7 Indexes added by task 1.7

| Index                                      | What it is for                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MediaRendition(assetId, name)` **unique** | A constraint doing real work: it is the upsert target that makes a redelivered transcode overwrite its row rather than add one. Not a performance index — it is the idempotency mechanism.                         |
| `MediaRendition(storageKey)` **unique**    | The key is identity. Two renditions sharing one would overwrite each other's bytes.                                                                                                                                |
| `MediaRendition(assetId, kind)`            | "Every rung for this asset" — read by packaging before it writes the master, and by the player. Bounded by the ladder (at most 7 rows per asset), so it will never be the bottleneck; the index keeps it a lookup. |

No `EXPLAIN` for the same reason as §7.5 and §7.6: every read here is by primary key or
bounded by one asset's handful of renditions. Numbers against that would prove nothing.

## 8. Reproducing this

```bash
export DATABASE_URL='postgresql://masternova:masternova@localhost:5432/masternova?schema=public'
pnpm -F @masternova/db run seed:catalog     # ~6 s; ends with ANALYZE and prints the literals below

docker compose exec -T postgres psql -U masternova -d masternova
```

```sql
SET track_io_timing = on;
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) <query from §6>;   -- 3 runs, take the median
```

The seed prints the literals every query above depends on — the hot and cold category ids,
the busiest instructor's id, the row-1000 keyset cursor, and a slug that has real sections.
They are stable across runs because the PRNG is seeded; if they ever change, `SEED` in
`catalog.seed.ts` changed and every number in this file needs re-taking.

**Note on state:** the six candidate indexes were created by hand for the "after" column and
**dropped again**. `Course` currently carries only `Course_pkey` and `Course_slug_key`, and
`prisma migrate status` reports the schema up to date. The indexes become real when they
land as `@@index` lines on `Course` in a migration of their own.

---

## 9. What the migration should contain

Reflecting §6.3, §6.4 and §6.6 rather than the original candidate list:

```prisma
model Course {
  // …
  /// The default catalog list and every keyset page of it. `id` is in the key because
  /// `publishedAt` is not unique and a paginated sort on a non-unique key duplicates rows.
  @@index([status, publishedAt(sort: Desc), id(sort: Desc)])
  /// Category browse. `id` trails `publishedAt` to remove the Incremental Sort (§6.3).
  @@index([status, categoryId, publishedAt(sort: Desc), id(sort: Desc)])
  /// "Highest rated" — indexable only because `ratingAverage` is denormalised (§6.8).
  @@index([status, ratingAverage(sort: Desc), id(sort: Desc)])
  /// Instructor dashboard. No `status` column: the default tab does not filter by it, and
  /// putting it between the equality key and the sort key costs the ordering (§6.6).
  @@index([instructorId, updatedAt(sort: Desc)])
  /// Interim substring search until Typesense (task 1.13). Needs `type: Gin` + `ops`.
  @@index([title(ops: raw("gin_trgm_ops"))], type: Gin)
}
```

`(status, priceMinor)` is deliberately absent (§6.4).

---

## 10. Interview notes — 60-second recall

10,000 courses, realistically skewed: 78% published, Zipf categories where the top 3 hold
39%, one instructor with 175 courses, and a substring term that matches 125 titles. Six
candidate indexes measured with `EXPLAIN (ANALYZE, BUFFERS)`, three runs, median.

**The headline:** the catalog list went from 7.8 ms and 1,915 buffers to **0.105 ms and 23
buffers**, because the index removed the `Sort` node — before, Postgres sorted 7,786 rows to
return 21.

**The decision that mattered:** two of the six did not earn their place, and saying so is the
point. `(status, priceMinor)` filters 16.9% of the table, and with every index available the
planner ignored it in favour of the ordering index — 0.297 ms versus 3.000 ms for the
"purpose-built" one. And the instructor index shipped with its middle column removed, because
`(instructorId, status, updatedAt DESC)` cannot serve a query that does not filter status:
0.605 ms with a sort, 0.108 ms without.

**The surprise:** keyset pagination written as `a < x OR (a = x AND b < y)` performed like
`OFFSET` — 0.96 ms vs 1.13 ms, both touching ~1,032 buffers — because Postgres cannot make a
disjunction an index start condition. Written as the row comparison `(a, b) < (x, y)` it was
**0.121 ms and 24 buffers**. Same pattern, same index, 8× apart, entirely down to how the
predicate is spelled.
