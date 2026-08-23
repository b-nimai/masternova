import { InvalidPriceRangeException } from '../../../common/exceptions';
import {
  all,
  and,
  none,
  not,
  or,
  type CourseCandidate,
  type CourseSpecification,
} from './course-specification';
import {
  atLevel,
  byInstructor,
  hasStatus,
  hasTopic,
  inCategory,
  inCategoryTree,
  inLanguage,
  isFree,
  isPublished,
  priceBetween,
  ratedAtLeast,
  titleMatches,
  visibleTo,
} from './course-specifications';

/**
 * Pure unit tests — no database (CLAUDE.md §6), which is the whole point of the pattern:
 * a specification carries its rule in two forms, and the in-memory one is testable with a
 * literal. The risk the module actually carries is those two forms **drifting**, so most of
 * what follows checks `toWhere()` and `isSatisfiedBy()` against each other rather than
 * checking either one alone.
 */

const course = (over: Partial<CourseCandidate> = {}): CourseCandidate => ({
  id: 'crs-1',
  status: 'PUBLISHED',
  instructorId: 'inst-1',
  categoryId: 'cat-devops',
  level: 'INTERMEDIATE',
  language: 'en',
  priceMinor: 4999,
  ratingAverage: 4.5,
  title: 'Kubernetes in Anger',
  topics: ['kubernetes', 'sre'],
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

describe('CourseSpecification combinators', () => {
  it('renders a leaf as exactly the Prisma clause the column expects', () => {
    expect(isPublished().toWhere()).toEqual({ status: 'PUBLISHED' });
  });

  /**
   * The two cases a hand-rolled query builder always gets wrong. `and()` of nothing must
   * match EVERYTHING and `or()` of nothing must match NOTHING — the identity elements. Get
   * them backwards and "no filters selected" either returns an empty catalog or, far worse,
   * an unfiltered one: the same mistake in `or` is how a visibility rule stops applying.
   */
  it('treats and() with no arguments as the identity — matches everything', () => {
    expect(and().toWhere()).toEqual({});
    expect(and().isSatisfiedBy(course({ status: 'DRAFT' }))).toBe(true);
  });

  it('treats or() with no arguments as the identity — matches nothing', () => {
    expect(or().toWhere()).toEqual({ id: { in: [] } });
    expect(or().isSatisfiedBy(course())).toBe(false);
  });

  it('keeps all() and none() consistent across both representations', () => {
    expect(all().toWhere()).toEqual({});
    expect(all().isSatisfiedBy(course({ status: 'ARCHIVED' }))).toBe(true);
    expect(none().isSatisfiedBy(course())).toBe(false);
  });

  /**
   * AND-of-OR must stay nested. Flattening it — a tempting "simplification" when the
   * combinators are rewritten to merge sibling clauses — silently turns
   * `published AND (a OR b)` into `published OR a OR b`, which publishes every draft in
   * either category.
   */
  it('nests AND over OR without flattening the groups together', () => {
    const spec = and(isPublished(), or(inCategory('cat-a'), inCategory('cat-b')));

    expect(spec.toWhere()).toEqual({
      AND: [{ status: 'PUBLISHED' }, { OR: [{ categoryId: 'cat-a' }, { categoryId: 'cat-b' }] }],
    });
  });

  it('agrees with itself on the nested case', () => {
    const spec = and(isPublished(), or(inCategory('cat-a'), inCategory('cat-b')));

    expect(spec.isSatisfiedBy(course({ categoryId: 'cat-b' }))).toBe(true);
    // Published but in neither category — the OR group fails, so the AND fails.
    expect(spec.isSatisfiedBy(course({ categoryId: 'cat-c' }))).toBe(false);
    // In a category but a draft — the flattened-OR bug would let this through.
    expect(spec.isSatisfiedBy(course({ status: 'DRAFT', categoryId: 'cat-a' }))).toBe(false);
  });

  it('collapses a single-element group rather than wrapping it in a pointless AND', () => {
    // A one-filter query must produce the same clause as the leaf alone, so the EXPLAIN
    // pasted into docs/db/indexes.md is the one the index was chosen for.
    expect(and(isPublished()).toWhere()).toEqual({ status: 'PUBLISHED' });
    expect(or(isPublished()).toWhere()).toEqual({ status: 'PUBLISHED' });
  });

  it('drops all() from a group instead of emitting an empty clause beside real filters', () => {
    // `visibleTo(admin)` and `and()` both mean "no restriction"; leaving them in would put a
    // bare `{}` inside the AND array, which reads as a bug in every query log.
    expect(and(all(), isPublished(), all()).toWhere()).toEqual({ status: 'PUBLISHED' });
  });

  it('round-trips through not()', () => {
    const spec = not(isPublished());

    expect(spec.toWhere()).toEqual({ NOT: { status: 'PUBLISHED' } });
    expect(spec.isSatisfiedBy(course({ status: 'DRAFT' }))).toBe(true);
    expect(spec.isSatisfiedBy(course({ status: 'PUBLISHED' }))).toBe(false);
    expect(not(not(isPublished())).isSatisfiedBy(course())).toBe(true);
  });

  /**
   * `describe` is logged next to a slow query and pasted into the index docs, so it has to
   * read like the boolean expression it represents — including the parentheses, which are
   * the only thing distinguishing AND-of-OR from OR-of-AND when you are reading a log at
   * 2am.
   */
  it('composes describe strings that read as the expression they represent', () => {
    expect(isPublished().describe).toBe('published');
    expect(and(isPublished(), or(inCategory('cat-a'), inCategory('cat-b'))).describe).toBe(
      '(published AND (category=cat-a OR category=cat-b))',
    );
    expect(not(isFree()).describe).toBe('NOT free');
  });
});

/**
 * Every leaf, both ways. A leaf whose `toWhere()` and `isSatisfiedBy()` disagree is the one
 * failure mode this pattern can produce that no other test would notice: the list endpoint
 * and the entitlement engine would then answer differently about the same course.
 */
describe('leaf specifications — the two representations agree', () => {
  const cases: {
    name: string;
    spec: CourseSpecification;
    where: unknown;
    match: CourseCandidate;
    miss: CourseCandidate;
  }[] = [
    {
      name: 'isPublished',
      spec: isPublished(),
      where: { status: 'PUBLISHED' },
      match: course({ status: 'PUBLISHED' }),
      miss: course({ status: 'DRAFT' }),
    },
    {
      name: 'hasStatus(ARCHIVED)',
      spec: hasStatus('ARCHIVED'),
      where: { status: 'ARCHIVED' },
      match: course({ status: 'ARCHIVED' }),
      miss: course({ status: 'PUBLISHED' }),
    },
    {
      name: 'byInstructor',
      spec: byInstructor('inst-7'),
      where: { instructorId: 'inst-7' },
      match: course({ instructorId: 'inst-7' }),
      miss: course({ instructorId: 'inst-8' }),
    },
    {
      name: 'inCategory',
      spec: inCategory('cat-devops'),
      where: { categoryId: 'cat-devops' },
      match: course({ categoryId: 'cat-devops' }),
      miss: course({ categoryId: 'cat-cloud' }),
    },
    {
      name: 'inCategoryTree',
      spec: inCategoryTree(['cat-devops', 'cat-k8s']),
      where: { categoryId: { in: ['cat-devops', 'cat-k8s'] } },
      match: course({ categoryId: 'cat-k8s' }),
      // Uncategorised: `categoryId IN (...)` is never true for NULL in SQL, and the
      // predicate has to null-check to match that.
      miss: course({ categoryId: null }),
    },
    {
      name: 'atLevel',
      spec: atLevel('BEGINNER'),
      where: { level: 'BEGINNER' },
      match: course({ level: 'BEGINNER' }),
      miss: course({ level: 'ADVANCED' }),
    },
    {
      name: 'inLanguage',
      spec: inLanguage('hi'),
      where: { language: 'hi' },
      match: course({ language: 'hi' }),
      miss: course({ language: 'en' }),
    },
    {
      name: 'isFree',
      spec: isFree(),
      where: { priceMinor: 0 },
      match: course({ priceMinor: 0 }),
      miss: course({ priceMinor: 1 }),
    },
    {
      name: 'priceBetween (bounds inclusive)',
      spec: priceBetween(1000, 5000),
      where: { priceMinor: { gte: 1000, lte: 5000 } },
      match: course({ priceMinor: 5000 }),
      miss: course({ priceMinor: 5001 }),
    },
    {
      name: 'ratedAtLeast (bound inclusive)',
      spec: ratedAtLeast(4),
      where: { ratingAverage: { gte: 4 } },
      match: course({ ratingAverage: 4 }),
      miss: course({ ratingAverage: 3.9 }),
    },
    {
      name: 'titleMatches (case-insensitive substring)',
      spec: titleMatches('ANGER'),
      where: { title: { contains: 'ANGER', mode: 'insensitive' } },
      match: course({ title: 'Kubernetes in Anger' }),
      miss: course({ title: 'Kubernetes for Calm People' }),
    },
    {
      name: 'hasTopic',
      spec: hasTopic('sre'),
      where: { topics: { has: 'sre' } },
      match: course({ topics: ['sre'] }),
      miss: course({ topics: ['kubernetes'] }),
    },
  ];

  it.each(cases)('$name', ({ spec, where, match, miss }) => {
    expect(spec.toWhere()).toEqual(where);
    expect(spec.isSatisfiedBy(match)).toBe(true);
    expect(spec.isSatisfiedBy(miss)).toBe(false);
  });
});

describe('priceBetween', () => {
  /**
   * An inverted range is a caller bug, and "no results" would hide it in a UI that looks
   * like it is simply an empty catalog. It must be the domain exception, not a bare Error:
   * only an HttpException carries the status the AllExceptionsFilter shapes (CLAUDE.md §4).
   */
  it('rejects an inverted range with the domain exception rather than matching nothing', () => {
    expect(() => priceBetween(9900, 0)).toThrow(InvalidPriceRangeException);
  });

  it('allows a single-value range, which is a legitimate exact-price filter', () => {
    expect(() => priceBetween(4999, 4999)).not.toThrow();
  });
});

/**
 * ⭐ `visibleTo` is an authorization rule, and these four tests prove it with no database,
 * no HTTP and no session — because the rule is an object, not a `where` fragment scattered
 * across three query sites. That is the entire argument for the Specification pattern here:
 * the property "a stranger never sees a draft" is a unit test, not an integration test you
 * hope someone wrote.
 */
describe('visibleTo', () => {
  const draft = course({ status: 'DRAFT', instructorId: 'inst-1' });
  const published = course({ status: 'PUBLISHED', instructorId: 'inst-1' });

  it('never shows an anonymous visitor a draft', () => {
    const spec = visibleTo(undefined);

    expect(spec.isSatisfiedBy(draft)).toBe(false);
    expect(spec.isSatisfiedBy(published)).toBe(true);
    // Composed into the WHERE, so the draft 404s rather than 200-then-403 — a 403 would
    // confirm the course exists.
    expect(spec.toWhere()).toEqual({ status: 'PUBLISHED' });
  });

  it('shows an instructor their own draft', () => {
    expect(visibleTo({ id: 'inst-1', role: 'INSTRUCTOR' }).isSatisfiedBy(draft)).toBe(true);
  });

  it("does not show an instructor another instructor's draft", () => {
    // The leak this rule exists to prevent: an authenticated instructor is not thereby
    // entitled to the whole authoring surface of the platform.
    expect(visibleTo({ id: 'inst-2', role: 'INSTRUCTOR' }).isSatisfiedBy(draft)).toBe(false);
    expect(visibleTo({ id: 'inst-2', role: 'INSTRUCTOR' }).isSatisfiedBy(published)).toBe(true);
  });

  it('shows a learner published courses only, whoever owns them', () => {
    const spec = visibleTo({ id: 'user-9', role: 'LEARNER' });

    expect(spec.isSatisfiedBy(published)).toBe(true);
    expect(spec.isSatisfiedBy(draft)).toBe(false);
  });

  it('shows an ADMIN everything, and says so with an unrestricted clause', () => {
    const spec = visibleTo({ id: 'admin-1', role: 'ADMIN' });

    for (const status of ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED'] as const) {
      expect(spec.isSatisfiedBy(course({ status, instructorId: 'someone-else' }))).toBe(true);
    }
    expect(spec.toWhere()).toEqual({});
  });

  it('renders a signed-in viewer as published OR mine', () => {
    expect(visibleTo({ id: 'inst-1', role: 'INSTRUCTOR' }).toWhere()).toEqual({
      OR: [{ status: 'PUBLISHED' }, { instructorId: 'inst-1' }],
    });
  });
});
