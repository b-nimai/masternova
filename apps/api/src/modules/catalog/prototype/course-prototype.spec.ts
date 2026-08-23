import { cloneCourse, type CourseAggregate } from './course-prototype';

/**
 * `cloneCourse` is a pure function — no I/O, no injection, no database — which is exactly
 * why the interesting half of "duplicate this course" can be proved here rather than in an
 * integration test (CLAUDE.md §6). What is reset, what is deep-copied, and what is
 * deliberately shared are all decisions, and all three are asserted below.
 */

const aggregate = (over: Partial<CourseAggregate> = {}): CourseAggregate => ({
  id: 'crs-source',
  slug: 'kubernetes-in-anger-a1b2c3d4',
  title: 'Kubernetes in Anger',
  subtitle: 'Production, not tutorials',
  description: 'A long description.',
  language: 'en',
  level: 'ADVANCED',
  instructorId: 'inst-1',
  categoryId: 'cat-devops',
  topics: ['kubernetes', 'sre'],
  priceMinor: 499900,
  listPriceMinor: 799900,
  currency: 'INR',
  thumbnailKey: 'courses/crs-source/thumb.jpg',
  promoVideoAssetId: 'asset-promo',
  lectureCount: 3,
  totalDurationSeconds: 5400,
  sections: [
    {
      title: 'Getting started',
      position: 10,
      lectures: [
        {
          title: 'Why your cluster fell over',
          description: 'An honest post-mortem.',
          kind: 'VIDEO',
          position: 10,
          isPreview: true,
          durationSeconds: 600,
          assetId: 'asset-1',
          articleBody: null,
        },
        {
          title: 'Reading kubectl output',
          description: null,
          kind: 'ARTICLE',
          position: 20,
          isPreview: false,
          durationSeconds: 0,
          assetId: null,
          articleBody: '# Reading kubectl output',
        },
      ],
    },
    {
      title: 'Scheduling',
      position: 20,
      lectures: [
        {
          title: 'Taints and tolerations',
          description: null,
          kind: 'VIDEO',
          position: 10,
          isPreview: false,
          durationSeconds: 4800,
          assetId: 'asset-2',
          articleBody: null,
        },
      ],
    },
  ],
  ...over,
});

const clone = (over?: Partial<CourseAggregate>) =>
  cloneCourse(aggregate(over), { instructorId: 'inst-1', slug: 'copy-slug-99999999' });

describe('cloneCourse — what the copy must not inherit', () => {
  /**
   * These fields describe the *original's* history, not its content. They are absent from
   * the draft rather than stripped afterwards, so the column defaults apply — and a test
   * that only checked `status === 'DRAFT'` would pass while a stray `status: 'PUBLISHED'`
   * key silently republished the copy.
   */
  it('omits status entirely, so the copy falls to the DRAFT column default', () => {
    expect(clone().course).not.toHaveProperty('status');
  });

  it('carries no publish date and no optimistic-concurrency version', () => {
    expect(clone().course).not.toHaveProperty('publishedAt');
    expect(clone().course).not.toHaveProperty('version');
  });

  it('carries no rating or enrollment counters', () => {
    // "4.8 from 2,100 learners" on a course nobody has taken is a lie the moment it is
    // published, and it would rank the copy above courses that earned their rating.
    const draft = clone().course;

    expect(draft).not.toHaveProperty('ratingAverage');
    expect(draft).not.toHaveProperty('ratingCount');
    expect(draft).not.toHaveProperty('ratingSum');
    expect(draft).not.toHaveProperty('enrollmentCount');
  });

  it('never reuses the source id or slug', () => {
    const draft = clone().course;

    expect(draft.slug).toBe('copy-slug-99999999');
    expect(draft.slug).not.toBe(aggregate().slug);
    expect(draft).not.toHaveProperty('id');
  });
});

describe('cloneCourse — the deep copy', () => {
  /**
   * ⭐ THE Prototype property. A shallow `sections: source.sections` would pass every
   * structural assertion in this file and still let an edit to the copy rewrite the
   * original's lecture titles — the classic shallow-clone bug, invisible until an
   * instructor complains that renaming their duplicate renamed their published course.
   */
  it('does not let a mutation of the clone reach the source aggregate', () => {
    const source = aggregate();
    const draft = cloneCourse(source, { instructorId: 'inst-1', slug: 'copy-slug' });

    // The cast is the test doing on purpose what a careless caller would do by accident:
    // `NewSection` is readonly, which stops this at compile time in production code, but
    // the guarantee under test is that the *runtime* objects are not shared.
    const mutable = draft.sections as unknown as {
      title: string;
      lectures: { title: string }[];
    }[];
    mutable[0].lectures[0].title = 'Rewritten on the copy';
    mutable[0].title = 'Renamed on the copy';
    draft.sections.push({ title: 'Added on the copy', position: 30, lectures: [] });
    draft.course.topics.push('mutated');

    expect(source.sections[0].lectures[0].title).toBe('Why your cluster fell over');
    expect(source.sections[0].title).toBe('Getting started');
    expect(source.sections).toHaveLength(2);
    expect(source.topics).toEqual(['kubernetes', 'sre']);
  });

  it('preserves the structure — section and lecture counts, positions, preview flags', () => {
    const { sections } = clone();

    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.position)).toEqual([10, 20]);
    expect(sections.map((s) => s.lectures.length)).toEqual([2, 1]);
    expect(sections[0].lectures.map((l) => l.position)).toEqual([10, 20]);
    // The free preview is a marketing decision that belongs to the content, so it copies.
    expect(sections[0].lectures.map((l) => l.isPreview)).toEqual([true, false]);
    expect(sections[0].lectures.map((l) => l.kind)).toEqual(['VIDEO', 'ARTICLE']);
    expect(sections[0].lectures[1].articleBody).toBe('# Reading kubectl output');
  });

  /**
   * ⭐ The deliberate shallow edge, and it must stay shallow. A 40-lecture course is roughly
   * 12 GB of transcoded HLS; re-running the transcode pipeline for byte-identical content
   * would cost minutes and double the storage. An asset is immutable, so sharing the
   * reference is correct — and this test is here so nobody "fixes" it later.
   *
   * Its consequence, owed by media: assets are refcounted or soft-deleted, never hard
   * deleted because one course that references them was archived.
   */
  it('shares asset ids with the source rather than regenerating them', () => {
    const { course, sections } = clone();

    expect(course.promoVideoAssetId).toBe('asset-promo');
    expect(sections[0].lectures[0].assetId).toBe('asset-1');
    expect(sections[1].lectures[0].assetId).toBe('asset-2');
    // An article has no asset, and the copy must not invent one.
    expect(sections[0].lectures[1].assetId).toBeNull();
  });

  it('carries the pricing and the rest of the content over unchanged', () => {
    // A duplicate is a starting point; re-entering the price would be the first thing
    // anyone did anyway, and a copy that silently reset to free is a support ticket.
    const { course } = clone();

    expect(course).toMatchObject({
      description: 'A long description.',
      subtitle: 'Production, not tutorials',
      language: 'en',
      level: 'ADVANCED',
      categoryId: 'cat-devops',
      priceMinor: 499900,
      listPriceMinor: 799900,
      currency: 'INR',
      thumbnailKey: 'courses/crs-source/thumb.jpg',
      lectureCount: 3,
      totalDurationSeconds: 5400,
    });
  });

  it('maps a null subtitle to absent rather than to the string "null"', () => {
    expect(clone({ subtitle: null }).course.subtitle).toBeUndefined();
  });
});

describe('cloneCourse — the title', () => {
  it('suffixes the title so the two are distinguishable in a dashboard list', () => {
    expect(clone().course.title).toBe('Kubernetes in Anger (copy)');
  });

  /** Duplicating a duplicate is normal; "X (copy) (copy) (copy)" is not. */
  it('does not accumulate suffixes when a copy is itself copied', () => {
    expect(clone({ title: 'Kubernetes in Anger (copy)' }).course.title).toBe(
      'Kubernetes in Anger (copy)',
    );
  });

  it('lets an explicit title override win over the suffix', () => {
    const draft = cloneCourse(aggregate(), {
      instructorId: 'inst-1',
      slug: 'copy-slug',
      title: 'Kubernetes in Anger — 2027 edition',
    });

    expect(draft.course.title).toBe('Kubernetes in Anger — 2027 edition');
  });

  it('takes the owner from the overrides, not from the source', () => {
    // The seam the admin case needs: who owns the copy is the caller's decision, and the
    // pure function stays deterministic by being told rather than deciding.
    expect(
      cloneCourse(aggregate(), { instructorId: 'inst-2', slug: 'copy-slug' }).course.instructorId,
    ).toBe('inst-2');
  });
});
