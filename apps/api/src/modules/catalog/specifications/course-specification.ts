import type { CourseLevel, CourseStatus, Prisma } from '@masternova/db';

/**
 * A composable rule about which courses match.
 *
 * **The force.** The catalog list carries nine optional filters that combine freely.
 * Written inline that is nine `if (query.level) where.level = …` branches inside one
 * growing method — the query-builder explosion, and the `switch` CLAUDE.md §1 O forbids.
 * A named, composable rule makes "add a facet" mean "add a leaf", with zero edits to the
 * repository.
 *
 * **Why two representations.** `toWhere()` is what the database runs. `isSatisfiedBy()` is
 * the same rule evaluated in memory, and it is what makes every rule unit-testable with no
 * database — including the one that actually matters, `visibleTo`, which decides whether a
 * stranger can see an unpublished course. The entitlement engine (task 1.8) will evaluate
 * the same objects against a Redis-cached course where there is no query to run at all.
 *
 * **The honest trade-off.** `toWhere()` returns a Prisma type, so a specification is not
 * ORM-agnostic. The alternative is a neutral predicate AST plus a translator — a query
 * builder written to avoid a dependency already committed to in ADR-0001, which is exactly
 * the speculative generality §3 forbids. The two representations *can* drift; the
 * integration test that runs every leaf both ways and compares the ids is the guard.
 */
export interface CourseSpecification {
  /**
   * Human-readable, e.g. `published AND (category=devops OR category=cloud)`. Logged with
   * slow queries and pasted next to the EXPLAIN in `docs/db/indexes.md`.
   */
  readonly describe: string;
  toWhere(): Prisma.CourseWhereInput;
  isSatisfiedBy(course: CourseCandidate): boolean;
}

/**
 * The minimum a course-shaped object must expose to be judged.
 *
 * Structurally typed on purpose, so a Prisma row, a cache entry and a test literal all
 * satisfy it without a mapper standing between them.
 */
export interface CourseCandidate {
  readonly id: string;
  readonly status: CourseStatus;
  readonly instructorId: string;
  readonly categoryId: string | null;
  readonly level: CourseLevel;
  readonly language: string;
  readonly priceMinor: number;
  readonly ratingAverage: number;
  readonly title: string;
  readonly topics: readonly string[];
  readonly publishedAt: Date | null;
}

const spec = (
  describe: string,
  where: () => Prisma.CourseWhereInput,
  predicate: (course: CourseCandidate) => boolean,
): CourseSpecification => ({ describe, toWhere: where, isSatisfiedBy: predicate });

/** Matches everything. The identity element of `and`. */
export const all = (): CourseSpecification =>
  spec(
    'all',
    () => ({}),
    () => true,
  );

/**
 * Matches nothing. The identity element of `or`.
 *
 * `{ id: { in: [] } }` rather than an impossible comparison, because Postgres plans
 * `IN ()` as a constant-false and never touches the table.
 */
export const none = (): CourseSpecification =>
  spec(
    'none',
    () => ({ id: { in: [] } }),
    () => false,
  );

/**
 * Combinators are free functions over plain objects rather than methods on an abstract
 * base (CLAUDE.md §3 prefers composition). `and(a, b, c)` also reads better than
 * `a.and(b).and(c)` for the variadic case the controller actually produces.
 *
 * The identity cases are the ones a hand-rolled builder always gets wrong: `and()` of
 * nothing must match everything, and `or()` of nothing must match nothing.
 */
export const and = (...specs: CourseSpecification[]): CourseSpecification => {
  const present = specs.filter((s) => s.describe !== 'all');
  if (present.length === 0) return all();
  if (present.length === 1) return present[0];

  return spec(
    `(${present.map((s) => s.describe).join(' AND ')})`,
    () => ({ AND: present.map((s) => s.toWhere()) }),
    (course) => present.every((s) => s.isSatisfiedBy(course)),
  );
};

export const or = (...specs: CourseSpecification[]): CourseSpecification => {
  if (specs.length === 0) return none();
  if (specs.length === 1) return specs[0];

  return spec(
    `(${specs.map((s) => s.describe).join(' OR ')})`,
    () => ({ OR: specs.map((s) => s.toWhere()) }),
    (course) => specs.some((s) => s.isSatisfiedBy(course)),
  );
};

export const not = (inner: CourseSpecification): CourseSpecification =>
  spec(
    `NOT ${inner.describe}`,
    () => ({ NOT: inner.toWhere() }),
    (course) => !inner.isSatisfiedBy(course),
  );

export { spec as defineSpecification };
