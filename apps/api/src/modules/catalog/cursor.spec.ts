import type { CourseSort } from '@masternova/shared';
import { InvalidCursorException } from '../../common/exceptions';
import { after, cursorKeyOf, decodeCursor, encodeCursor, orderByFor } from './cursor';
import type { CourseCandidate } from './specifications/course-specification';

/**
 * Keyset pagination is the kind of code that looks right and is off by one row. All of it is
 * pure string and clause construction, so all of it is provable without Postgres
 * (CLAUDE.md §6) — the tuple comparison, the tiebreaker, and the refusal to accept a cursor
 * that was issued for a different sort.
 */

const SORTS: CourseSort[] = ['NEWEST', 'RATING', 'PRICE_ASC', 'PRICE_DESC', 'RECENT'];

/** A candidate wide enough for both the filter specs and the `RECENT` cursor. */
const row = (
  over: Partial<CourseCandidate & { updatedAt: Date }> = {},
): CourseCandidate & {
  updatedAt: Date;
} => ({
  id: 'crs-5',
  status: 'PUBLISHED',
  instructorId: 'inst-1',
  categoryId: 'cat-1',
  level: 'ALL_LEVELS',
  language: 'en',
  priceMinor: 4999,
  ratingAverage: 4.5,
  title: 'Kubernetes in Anger',
  topics: [],
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  ...over,
});

describe('encode / decode', () => {
  it.each(SORTS)('round-trips a cursor issued for %s', (sort) => {
    const payload = { sort, key: cursorKeyOf(sort, row()), id: 'crs-5' };

    expect(decodeCursor(encodeCursor(payload), sort)).toEqual(payload);
  });

  it('is opaque — the encoded form carries no readable offset for a client to guess at', () => {
    const encoded = encodeCursor({ sort: 'NEWEST', key: '2026-01-01T00:00:00.000Z', id: 'crs-5' });

    expect(encoded).not.toContain('|');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  /**
   * The reason the sort travels inside the cursor. Replayed against another sort, the key
   * would be compared as the wrong type — a date against a rating — and the page would come
   * back silently wrong rather than loudly rejected.
   */
  it('rejects a cursor issued for one sort and replayed against another', () => {
    const encoded = encodeCursor({ sort: 'NEWEST', key: '2026-01-01T00:00:00.000Z', id: 'crs-5' });

    expect(() => decodeCursor(encoded, 'RATING')).toThrow(InvalidCursorException);
  });

  /**
   * A hand-edited cursor is a client bug or an attack, and either way it must land in the
   * error envelope as a 400 — a bare TypeError out of `Buffer`/`split` would surface as a
   * 500 and page someone (CLAUDE.md §4).
   */
  it.each([
    ['empty', ''],
    ['garbage', 'not-a-real-cursor'],
    ['truncated', encodeCursor({ sort: 'NEWEST', key: '2026-01-01', id: 'crs-5' }).slice(0, 8)],
    ['missing the id', Buffer.from('NEWEST|2026-01-01', 'utf8').toString('base64url')],
    ['missing the key', Buffer.from('NEWEST||crs-5', 'utf8').toString('base64url')],
    ['no sort at all', Buffer.from('|2026-01-01|crs-5', 'utf8').toString('base64url')],
  ])('rejects a %s cursor with the domain exception', (_name, encoded) => {
    expect(() => decodeCursor(encoded, 'NEWEST')).toThrow(InvalidCursorException);
  });

  /**
   * Regression: an instructor's dashboard sorts by NEWEST across every status, so the last
   * row of a page can be a DRAFT with `publishedAt` null. That row must still produce a
   * cursor the next request can decode — before the null key was encoded as an empty
   * string, which `decodeCursor` rejected, and page 2 of the dashboard 400'd.
   */
  it('issues a decodable cursor for a row that has never been published', () => {
    const draft = row({ id: 'crs-draft', publishedAt: null });
    const encoded = encodeCursor({
      sort: 'NEWEST',
      key: cursorKeyOf('NEWEST', draft),
      id: draft.id,
    });

    expect(() => decodeCursor(encoded, 'NEWEST')).not.toThrow();
    expect(decodeCursor(encoded, 'NEWEST').id).toBe('crs-draft');
  });
});

describe('cursorKeyOf', () => {
  it('takes the key from the column the sort actually orders by', () => {
    const source = row({ publishedAt: new Date('2026-03-04T05:06:07.000Z') });

    expect(cursorKeyOf('NEWEST', source)).toBe('2026-03-04T05:06:07.000Z');
    expect(cursorKeyOf('RATING', source)).toBe('4.5');
    expect(cursorKeyOf('PRICE_ASC', source)).toBe('4999');
    expect(cursorKeyOf('PRICE_DESC', source)).toBe('4999');
  });

  it('keeps millisecond precision, because two courses can publish in the same second', () => {
    // Truncating to seconds would make the tuple non-unique again and reintroduce the very
    // duplicate-row bug the tiebreaker exists to prevent.
    expect(cursorKeyOf('NEWEST', row({ publishedAt: new Date('2026-03-04T05:06:07.123Z') }))).toBe(
      '2026-03-04T05:06:07.123Z',
    );
  });
});

describe('orderByFor', () => {
  /**
   * The classic keyset bug: order by a non-unique column alone and two courses sharing a
   * sort key can land on two pages or on neither, depending on how the planner happens to
   * break the tie that day. `(sortKey, id)` is a total order; the assertion below is that
   * every sort has one, forever, including any sort added later.
   */
  it.each(SORTS)('%s orders by exactly two columns, ending in the id tiebreaker', (sort) => {
    const orderBy = orderByFor(sort);

    expect(orderBy).toHaveLength(2);
    expect(Object.keys(orderBy[1])).toEqual(['id']);
  });

  it('points the tiebreaker the same way as the sort key, never against it', () => {
    // A descending sort key with an ascending id would make the tuple comparison in
    // `after()` disagree with the ORDER BY, and rows would be skipped at every page edge.
    for (const sort of SORTS) {
      const [key, id] = orderByFor(sort);
      expect(directionOf(id)).toBe(directionOf(key));
    }
  });

  it('sorts the catalog by publish date and the price facets by price', () => {
    expect(orderByFor('RATING')).toEqual([{ ratingAverage: 'desc' }, { id: 'desc' }]);
    expect(orderByFor('PRICE_ASC')).toEqual([{ priceMinor: 'asc' }, { id: 'asc' }]);
    expect(orderByFor('PRICE_DESC')).toEqual([{ priceMinor: 'desc' }, { id: 'desc' }]);
    expect(orderByFor('RECENT')).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
  });

  /**
   * `nulls: 'last'` is load-bearing, not cosmetic. Postgres puts NULLs FIRST under a
   * descending sort, so without it an instructor's unpublished drafts would head the
   * public catalog above every published course.
   */
  it('pushes unpublished courses to the end of the catalog sort', () => {
    expect(orderByFor('NEWEST')).toEqual([
      { publishedAt: { sort: 'desc', nulls: 'last' } },
      { id: 'desc' },
    ]);
  });
});

describe('after', () => {
  /**
   * The two-branch tuple comparison, which is the whole of keyset pagination:
   * "strictly past the sort key, OR on the same sort key but past the id". Collapse it to
   * the first branch alone and every row tied on the sort key is dropped; collapse it to a
   * non-strict `lte` and the last row of the previous page repeats on this one.
   */
  it('renders (key, id) as a two-branch comparison for a descending sort', () => {
    const spec = after({ sort: 'RATING', key: '4.5', id: 'crs-5' });

    expect(spec.toWhere()).toEqual({
      OR: [{ ratingAverage: { lt: 4.5 } }, { ratingAverage: 4.5, id: { lt: 'crs-5' } }],
    });
  });

  it('flips the comparison for PRICE_ASC, the one ascending sort', () => {
    // Sharing the descending branch would page backwards through the cheapest courses and
    // return the same first page forever.
    const spec = after({ sort: 'PRICE_ASC', key: '4999', id: 'crs-5' });

    expect(spec.toWhere()).toEqual({
      OR: [{ priceMinor: { gt: 4999 } }, { priceMinor: 4999, id: { gt: 'crs-5' } }],
    });
  });

  it('compares NEWEST as a Date, not as the string the cursor carried', () => {
    // A string comparison would happen to work for ISO-8601 and break the day the key
    // format changes; Prisma also needs a Date to bind the parameter as timestamptz.
    const where = after({
      sort: 'NEWEST',
      key: '2026-01-01T00:00:00.000Z',
      id: 'crs-5',
    }).toWhere() as { OR: { publishedAt?: { lt?: Date } }[] };

    expect(where.OR[0].publishedAt?.lt).toBeInstanceOf(Date);
  });

  it('describes itself so a slow page shows which cursor produced it', () => {
    expect(after({ sort: 'RATING', key: '4.5', id: 'crs-5' }).describe).toBe(
      'after(RATING:4.5,crs-5)',
    );
  });

  /**
   * The in-memory half of the same rule. It exists so the spec-agreement test can run the
   * cursor without a database, and it has to answer identically to the clause above at the
   * three places that matter: past the key, on the key, before the key.
   */
  describe('isSatisfiedBy agrees with the clause', () => {
    it('accepts a row strictly past the anchor and rejects one before it', () => {
      const spec = after({ sort: 'RATING', key: '4.5', id: 'crs-5' });

      expect(spec.isSatisfiedBy(row({ ratingAverage: 4.4 }))).toBe(true);
      expect(spec.isSatisfiedBy(row({ ratingAverage: 4.6 }))).toBe(false);
    });

    it('breaks a tie on the sort key with the id, in the same direction', () => {
      const spec = after({ sort: 'RATING', key: '4.5', id: 'crs-5' });

      expect(spec.isSatisfiedBy(row({ id: 'crs-4', ratingAverage: 4.5 }))).toBe(true);
      expect(spec.isSatisfiedBy(row({ id: 'crs-6', ratingAverage: 4.5 }))).toBe(false);
    });

    it('never returns the anchor row itself', () => {
      // The off-by-one that shows up as a duplicate card at every page boundary.
      const spec = after({ sort: 'RATING', key: '4.5', id: 'crs-5' });

      expect(spec.isSatisfiedBy(row({ id: 'crs-5', ratingAverage: 4.5 }))).toBe(false);
    });

    it('runs ascending for PRICE_ASC, both on the key and on the tiebreaker', () => {
      const spec = after({ sort: 'PRICE_ASC', key: '4999', id: 'crs-5' });

      expect(spec.isSatisfiedBy(row({ priceMinor: 5000 }))).toBe(true);
      expect(spec.isSatisfiedBy(row({ priceMinor: 4998 }))).toBe(false);
      expect(spec.isSatisfiedBy(row({ id: 'crs-6', priceMinor: 4999 }))).toBe(true);
      expect(spec.isSatisfiedBy(row({ id: 'crs-4', priceMinor: 4999 }))).toBe(false);
    });

    it('compares dates for NEWEST', () => {
      const spec = after({ sort: 'NEWEST', key: '2026-01-01T00:00:00.000Z', id: 'crs-5' });

      expect(spec.isSatisfiedBy(row({ publishedAt: new Date('2025-12-31T23:59:59.999Z') }))).toBe(
        true,
      );
      expect(spec.isSatisfiedBy(row({ publishedAt: new Date('2026-01-02T00:00:00.000Z') }))).toBe(
        false,
      );
    });

    it('keeps unpublished rows in a NEWEST page anchored on a published one', () => {
      // `nulls: 'last'` puts undated courses after every dated one, so they are always
      // still to come — and `publishedAt < :date` is never true for NULL in SQL, so the
      // clause needs an explicit `publishedAt: null` branch or the list stops dead at the
      // first draft.
      const spec = after({ sort: 'NEWEST', key: '2026-01-01T00:00:00.000Z', id: 'crs-5' });

      expect(spec.isSatisfiedBy(row({ publishedAt: null }))).toBe(true);
      expect(spec.toWhere()).toEqual(
        expect.objectContaining({
          OR: expect.arrayContaining([{ publishedAt: null }]),
        }),
      );
    });

    it('pages on past an unpublished anchor using the id alone', () => {
      // The instructor-dashboard case: several drafts share a null publish date, so the id
      // is the only thing separating them — and because they sort last, nothing dated can
      // follow one of them.
      const spec = after({
        sort: 'NEWEST',
        key: cursorKeyOf('NEWEST', row({ publishedAt: null })),
        id: 'crs-5',
      });

      expect(spec.isSatisfiedBy(row({ id: 'crs-4', publishedAt: null }))).toBe(true);
      expect(spec.isSatisfiedBy(row({ id: 'crs-6', publishedAt: null }))).toBe(false);
      expect(spec.isSatisfiedBy(row({ id: 'crs-9' }))).toBe(false);
    });
  });
});

/** Direction only — `NEWEST` carries a `nulls` hint alongside its `desc`. */
function directionOf(clause: Record<string, unknown>): string {
  const value = Object.values(clause)[0];
  return typeof value === 'string' ? value : (value as { sort: string }).sort;
}
