import { PUBLISH_REQUIREMENTS, readinessOf, type ReadinessSnapshot } from './publish-gate';

/**
 * The gate is a pure function over literals, so these tests need no database, no Nest and
 * no fixtures — which is the point of having kept it pure (CLAUDE.md §6).
 */

const publishable = (overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  title: 'Kubernetes in Anger',
  subtitle: 'Run it in production without crying',
  description: 'x'.repeat(120),
  categoryId: 'cat_1',
  thumbnailKey: 'thumbs/abc.png',
  priceSetAt: new Date('2026-08-23T00:00:00Z'),
  sections: [
    {
      title: 'Getting started',
      lectures: [
        {
          title: 'Welcome',
          kind: 'VIDEO',
          isPreview: true,
          assetId: 'asset_1',
          articleBody: null,
        },
      ],
    },
  ],
  ...overrides,
});

describe('publish gate', () => {
  it('passes a complete course', () => {
    const readiness = readinessOf(publishable());

    expect(readiness.ready).toBe(true);
    expect(readiness.problems).toHaveLength(0);
    expect(readiness.steps.every((step) => step.complete)).toBe(true);
  });

  /**
   * Every requirement gets its own case by construction, so adding a rule without a test
   * is not possible: the list is the source of both.
   */
  it.each(PUBLISH_REQUIREMENTS.map((rule) => [rule.code, rule] as const))(
    '%s is met by a publishable course',
    (_code, rule) => {
      expect(rule.isMetBy(publishable())).toBe(true);
    },
  );

  it.each([
    ['SUBTITLE_MISSING', { subtitle: null }],
    ['SUBTITLE_MISSING', { subtitle: '   ' }],
    ['DESCRIPTION_TOO_SHORT', { description: 'too short' }],
    ['CATEGORY_MISSING', { categoryId: null }],
    ['THUMBNAIL_MISSING', { thumbnailKey: null }],
    ['PRICE_NOT_CONFIRMED', { priceSetAt: null }],
    ['NO_SECTIONS', { sections: [] }],
  ] as const)('reports %s', (code, overrides) => {
    const readiness = readinessOf(publishable(overrides));

    expect(readiness.ready).toBe(false);
    expect(readiness.problems.map((problem) => problem.code)).toContain(code);
  });

  it('rejects a section with no lectures', () => {
    const readiness = readinessOf(
      publishable({ sections: [{ title: 'Coming soon', lectures: [] }] }),
    );

    expect(readiness.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['EMPTY_SECTION', 'NO_PREVIEW_LECTURE']),
    );
  });

  it('rejects a video lecture with no uploaded asset', () => {
    const course = publishable();
    const readiness = readinessOf({
      ...course,
      sections: [
        {
          title: course.sections[0].title,
          lectures: [{ ...course.sections[0].lectures[0], assetId: null }],
        },
      ],
    });

    expect(readiness.problems.map((problem) => problem.code)).toContain('MEDIA_MISSING');
  });

  /** An article needs no asset — the media rule must not fire on the wrong lecture kind. */
  it('accepts an article lecture with a body and no asset', () => {
    const readiness = readinessOf(
      publishable({
        sections: [
          {
            title: 'Reading',
            lectures: [
              {
                title: 'Why HLS',
                kind: 'ARTICLE',
                isPreview: true,
                assetId: null,
                articleBody: 'Because progressive MP4 cannot switch bitrate mid-stream.',
              },
            ],
          },
        ],
      }),
    );

    expect(readiness.ready).toBe(true);
  });

  it('rejects an article lecture with an empty body', () => {
    const readiness = readinessOf(
      publishable({
        sections: [
          {
            title: 'Reading',
            lectures: [
              {
                title: 'Why HLS',
                kind: 'ARTICLE',
                isPreview: true,
                assetId: null,
                articleBody: '  ',
              },
            ],
          },
        ],
      }),
    );

    expect(readiness.problems.map((problem) => problem.code)).toContain('ARTICLE_EMPTY');
  });

  it('rejects a course with no free preview', () => {
    const course = publishable();
    const readiness = readinessOf({
      ...course,
      sections: [
        {
          title: course.sections[0].title,
          lectures: [{ ...course.sections[0].lectures[0], isPreview: false }],
        },
      ],
    });

    expect(readiness.problems.map((problem) => problem.code)).toContain('NO_PREVIEW_LECTURE');
  });

  /**
   * The property the wizard depends on: the checklist and the gate are the same answer, so
   * "every step ticked" and "publishable" can never disagree.
   */
  it('marks exactly the steps that carry a problem as incomplete', () => {
    const readiness = readinessOf(publishable({ categoryId: null, priceSetAt: null }));

    expect(readiness.steps.filter((step) => !step.complete).map((step) => step.step)).toEqual([
      'DETAILS',
      'PRICING',
    ]);
    expect(readiness.steps.flatMap((step) => step.problems)).toHaveLength(
      readiness.problems.length,
    );
  });
});
