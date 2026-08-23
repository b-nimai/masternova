# ADR-0015 — Keyset cursors over `LIMIT/OFFSET` pagination

**Status:** accepted · **Date:** 2026-08-22 · **Deciders:** Nimai

## Context

The catalog is the most-read surface in the product and it is a list. Every list in this
codebase — courses, an instructor's drafts, later reviews, Q&A, orders and payouts — needs
a way to ask for the next page, and whatever is chosen here becomes the convention the API
documents once in `docs/api/conventions.md` and repeats everywhere.

The obvious choice is `LIMIT 20 OFFSET n`, because it is what a page number maps onto and
because the UI mockups show page numbers. It has two problems, and only one of them is
about speed.

**It gets slower the further you scroll.** `OFFSET 1000` does not skip a thousand rows; it
produces them and throws them away. Page 50 costs fifty times page 1, and the cost is paid
by exactly the users who are engaged enough to keep scrolling.

**It is wrong under concurrent writes.** This is the part that matters more. If a course is
published while someone is reading page 1, every row shifts down by one, and the row that
was last on page 1 becomes first on page 2 — the reader sees it twice. A row deleted has
the mirror bug: something is skipped entirely and nobody ever knows. In a marketplace where
courses are published continuously, this is not a rare race; it is the normal case.

## Decision

**Keyset (seek) pagination, with an opaque cursor.**

A page is requested by "everything after this point in the sort order", not "starting at row
n". Three details are load-bearing:

1. **Every sort carries `id` as a tiebreaker.** Two courses published in the same
   millisecond are indistinguishable to `publishedAt` alone, and the pair can then appear on
   two pages or on neither. `(sortKey, id)` is a total order because `id` is unique. This is
   the single most common way keyset pagination is implemented wrong, so `orderByFor()` has
   no branch that returns fewer than two columns, and a unit test asserts it for every sort.

2. **The predicate is a two-branch disjunction**, because that is the only shape
   `Prisma.CourseWhereInput` can express:

   ```sql
   WHERE ("publishedAt" < $1) OR ("publishedAt" = $1 AND id < $2)
   ORDER BY "publishedAt" DESC, id DESC
   LIMIT 21
   ```

   **This is the part measurement changed, and it is worth being honest about.** A
   disjunction cannot become an index _start_ condition, so Postgres begins at the top of
   the `PUBLISHED` range and walks the entries it will discard — at page 50 of 10,000
   seeded courses that is **0.964 ms / 1,032 buffers**, against **1.133 ms / 1,032** for
   plain `OFFSET`. The clever cursor bought almost nothing.

   The row-comparison form `("publishedAt", id) < ($1, $2)` _is_ a start condition:
   **0.121 ms / 24 buffers**, 8× the `OR` form and 9× `OFFSET`, and flat with depth.
   Prisma cannot emit it, and its own `cursor` option emits something worse still — an
   OR-chain over correlated subqueries. Both plans are in `docs/db/indexes.md` §6.2.

   The disjunction ships anyway, because sub-millisecond at page 50 is not the constraint
   and losing the Specification composition to hand-written SQL would be. **The named
   breaking point:** when a list is routinely paged past a few thousand rows, the keyset
   clause drops to `Prisma.sql`. Search moves to Typesense in task 1.13 before that is
   likely to bite.

3. **The cursor is opaque and carries its sort.** It is base64url of `sort|key|id`. Opaque
   because a client that parses a cursor is a client that breaks the day the sort key
   changes; carrying the sort because a cursor issued for `NEWEST` and replayed against
   `RATING` would otherwise compare a date to a rating and return nonsense. A mismatch is a
   400, not a 500.

A page is fetched as `LIMIT n + 1`. The extra row is how "is there a next page?" is
answered without a `COUNT`, and its absence is what makes `nextCursor` null.

**The response has no `total`.** Counting the matching set on every page is precisely the
cost this decision exists to avoid. Facet counts, when the UI needs them, come from
Typesense in task 1.13 — a search engine counts cheaply, an OLTP database does not.

## Consequences

**Positive.** Concurrent inserts cannot duplicate or skip a row — which, per the
measurement above, is now the _primary_ justification rather than a co-benefit. The cursor is a specification like every other filter, so `list()` is written once and
never edited as facets are added. And because the sort key is in the index, the plan has no
`Sort` node at all.

**Negative.** **No page numbers, and no jump-to-page.** That is a real product constraint,
not a technicality: the UI must be infinite scroll or prev/next, and a design that shows
"page 7 of 42" cannot be built on this. It also means "go back one page" needs the client to
retain the previous cursor rather than decrement a number. Sorting is restricted to indexed
columns, which is a discipline rather than a cost. And a cursor is not portable across
sorts, so changing the sort resets to page 1 — which is what a user expects anyway.

**Accepted risk.** If a row's sort key is _updated_ between pages — a course repriced while
someone pages by price — that row can still be seen twice or missed. Keyset fixes
insert/delete drift, not update drift, and no pagination scheme fixes the latter without a
snapshot. The exposure is one row in a list that is refreshed constantly, and it is not
worth a repeatable-read transaction held open across HTTP requests.

**Evidence.** `docs/db/indexes.md` records the measured pair on 10,000 seeded courses: the
same deep page fetched by cursor and by `OFFSET`, before and after the composite index.
That table, not this argument, is what makes the decision defensible.
