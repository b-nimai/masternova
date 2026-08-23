import type { CourseSort } from '@masternova/shared';
import type { Prisma } from '@masternova/db';
import { InvalidCursorException } from '../../common/exceptions';
import {
  defineSpecification,
  type CourseSpecification,
} from './specifications/course-specification';

/**
 * Keyset (seek) pagination.
 *
 * **The force.** `OFFSET 1000` makes Postgres produce and discard a thousand rows on every
 * deep page, so page 50 costs fifty times page 1. Worse, it is *wrong* under concurrent
 * writes: a course published while someone reads page 2 shifts every row down one, and the
 * reader sees an item twice or never. A cursor anchored to the sort key has neither problem
 * — see ADR-0015 and the EXPLAIN pair in `docs/db/indexes.md`.
 *
 * **Why every sort carries `id` as a tiebreaker.** Two courses published in the same
 * millisecond are indistinguishable to `publishedAt` alone, and the pair can then appear on
 * two pages or on neither. `id` is unique, so the tuple `(sortKey, id)` is a total order.
 * This is the single most common way keyset pagination is implemented wrong.
 *
 * **A measured limitation, written down rather than glossed over.** The predicate below is
 * a disjunction, because that is the only shape `Prisma.CourseWhereInput` can express.
 * Postgres cannot turn a disjunction into an index *start* condition, so it begins at the
 * top of the range and walks the entries it will discard — at page 50 of the seeded 10k
 * catalog that is 0.964 ms against 0.121 ms for the row-comparison form
 * `("publishedAt", id) < ($1, $2)`, which *is* a start condition. Prisma cannot emit a row
 * comparison, and its own `cursor` option emits something worse still (an OR-chain over
 * correlated subqueries). Both numbers are in `docs/db/indexes.md` §6.2.
 *
 * The composable form ships because sub-millisecond is not the constraint here and losing
 * the specification composition to raw SQL would be. The named breaking point: when a list
 * is routinely paged past a few thousand rows, this file drops to `Prisma.sql` for the
 * keyset clause. Search moves to Typesense in task 1.13 before that is likely to bite.
 */

/**
 * The key an unpublished row carries under `NEWEST`.
 *
 * The instructor dashboard sorts every status by `publishedAt`, so the last row of a page
 * can be a draft. An empty key would be rejected by `decodeCursor` as hand-edited, which
 * made page 2 of the dashboard a 400; a sentinel keeps the cursor decodable and lets
 * `after` express the NULLS-FIRST half of the tuple comparison.
 */
const UNPUBLISHED_KEY = 'null';

export interface CursorPayload {
  /** The sort the cursor was issued for. A cursor is not portable across sorts. */
  readonly sort: CourseSort;
  /** The sort key of the last row on the previous page, as a string. */
  readonly key: string;
  readonly id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(`${payload.sort}|${payload.key}|${payload.id}`, 'utf8').toString('base64url');
}

/**
 * Decodes and rejects anything that does not belong.
 *
 * A cursor issued for `NEWEST` and replayed against `RATING` would silently compare a date
 * to a rating and return nonsense, so the sort travels inside the cursor and is checked.
 */
export function decodeCursor(encoded: string, expected: CourseSort): CursorPayload {
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const [sort, key, id] = decoded.split('|');

  if (!sort || !key || !id || sort !== expected) throw new InvalidCursorException();
  return { sort: sort as CourseSort, key, id };
}

/** `ORDER BY` for a sort. Always two columns, always ending in `id`. */
export function orderByFor(sort: CourseSort): Prisma.CourseOrderByWithRelationInput[] {
  switch (sort) {
    case 'RATING':
      return [{ ratingAverage: 'desc' }, { id: 'desc' }];
    case 'PRICE_ASC':
      return [{ priceMinor: 'asc' }, { id: 'asc' }];
    case 'PRICE_DESC':
      return [{ priceMinor: 'desc' }, { id: 'desc' }];
    case 'RECENT':
      return [{ updatedAt: 'desc' }, { id: 'desc' }];
    case 'NEWEST':
    default:
      // `nulls: 'last'` is not cosmetic. Postgres sorts NULLs FIRST under DESC, so without
      // it an instructor's drafts would head the catalog above every published course.
      return [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
  }
}

/** The value a cursor carries for a given sort, taken from the last row of a page. */
export function cursorKeyOf(sort: CourseSort, row: CursorSource): string {
  switch (sort) {
    case 'RATING':
      return String(row.ratingAverage);
    case 'PRICE_ASC':
    case 'PRICE_DESC':
      return String(row.priceMinor);
    case 'RECENT':
      return row.updatedAt.toISOString();
    case 'NEWEST':
    default:
      return row.publishedAt ? row.publishedAt.toISOString() : UNPUBLISHED_KEY;
  }
}

export interface CursorSource {
  readonly id: string;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date;
  readonly ratingAverage: unknown;
  readonly priceMinor: number;
}

/**
 * The cursor **as a specification**.
 *
 * This is where composition pays off: the repository's list method is
 * `and(spec, after(cursor, sort)).toWhere()` and has no idea whether it is paginating a
 * search, a category browse, or an instructor's drafts.
 *
 * `isSatisfiedBy` is honest about its one limit — it is a strict "comes after" over the
 * same tuple, which is all the spec-agreement test needs it to be.
 */
export function after(cursor: CursorPayload): CourseSpecification {
  const { sort, key, id } = cursor;
  const ascending = sort === 'PRICE_ASC';
  const op = ascending ? 'gt' : 'lt';
  const value = valueFor(sort, key);
  const column = columnFor(sort);
  const describe = `after(${sort}:${key},${id})`;

  /*
   * The cursor is anchored on an unpublished row.
   *
   * `orderByFor('NEWEST')` asks for `nulls: 'last'`, so the order is every dated course
   * first and then the undated ones by id. What comes after an undated row is therefore
   * only more undated rows — never a dated one — and `publishedAt < NULL` cannot say that,
   * because a comparison against NULL is never true.
   */
  if (value === null) {
    return defineSpecification(
      describe,
      () => ({ publishedAt: null, id: { lt: id } }),
      (course) => course.publishedAt === null && course.id < id,
    );
  }

  return defineSpecification(
    describe,
    () => ({
      OR: [
        { [column]: { [op]: value } },
        { [column]: value, id: { [op]: id } },
        // Undated rows sort after every dated one, so they are always still to come.
        // Only `NEWEST` has a nullable sort column; the others cannot produce this branch.
        ...(column === 'publishedAt' ? [{ publishedAt: null }] : []),
      ] as Prisma.CourseWhereInput[],
    }),
    (course) => {
      const own = rawValue(sort, course);
      if (own === null) return column === 'publishedAt';
      const same = String(own) === String(value);
      if (same) return ascending ? course.id > id : course.id < id;
      return ascending ? own > value : own < value;
    },
  );
}

function columnFor(sort: CourseSort): 'publishedAt' | 'ratingAverage' | 'priceMinor' | 'updatedAt' {
  if (sort === 'RATING') return 'ratingAverage';
  if (sort === 'PRICE_ASC' || sort === 'PRICE_DESC') return 'priceMinor';
  if (sort === 'RECENT') return 'updatedAt';
  return 'publishedAt';
}

function valueFor(sort: CourseSort, key: string): Date | number | null {
  if (sort === 'RATING' || sort === 'PRICE_ASC' || sort === 'PRICE_DESC') return Number(key);
  if (sort === 'RECENT') return new Date(key);
  return key === UNPUBLISHED_KEY ? null : new Date(key);
}

function rawValue(sort: CourseSort, course: CursorCandidate): Date | number | null {
  if (sort === 'RATING') return course.ratingAverage;
  if (sort === 'PRICE_ASC' || sort === 'PRICE_DESC') return course.priceMinor;
  if (sort === 'RECENT') return course.updatedAt ?? null;
  return course.publishedAt;
}

/**
 * What `isSatisfiedBy` needs of a candidate. A superset of `CourseCandidate`, because the
 * `RECENT` sort reads a column the filter specifications never look at.
 */
export interface CursorCandidate {
  readonly id: string;
  readonly publishedAt: Date | null;
  readonly updatedAt?: Date;
  readonly ratingAverage: number;
  readonly priceMinor: number;
}
