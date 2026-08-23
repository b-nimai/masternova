import type { Course } from '@masternova/db';
import type { NewDomainEvent, TransactionContext, UnitOfWork } from '@masternova/contracts';
import { CourseDuplicationService } from './course-duplication.service';
import type { CourseAggregate } from './prototype/course-prototype';
import type { ICourseReader } from './repositories/course.reader.interface';
import type { ICourseWriter, NewCourse, NewSection } from './repositories/course.writer.interface';
import { CourseNotFoundException, NotCourseOwnerException } from '../../common/exceptions';

/**
 * Not one Prisma import in this file, and that absence is the point: the service depends on
 * `COURSE_READER`, `COURSE_WRITER` and `UNIT_OF_WORK`, so its behaviour — ownership,
 * atomicity, the event — is provable with three fakes and no database (CLAUDE.md §1 D, §6).
 * If this test needed Postgres, the design would be what to fix.
 */

const EXECUTOR = Symbol('transaction');

class FakeUnitOfWork implements UnitOfWork {
  published: NewDomainEvent[] = [];
  /** Which executor each write was handed — how "one transaction" is actually proved. */
  executorsSeen: unknown[] = [];

  execute<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const ctx: TransactionContext = {
      executor: EXECUTOR,
      publish: (event) => this.published.push(event),
    };
    return work(ctx);
  }
}

class FakeWriter implements ICourseWriter {
  created: NewCourse[] = [];
  sections: { courseId: string; sections: NewSection[] }[] = [];

  constructor(private readonly uow: FakeUnitOfWork) {}

  create(data: NewCourse, executor?: unknown): Promise<Course> {
    this.uow.executorsSeen.push(executor);
    this.created.push(data);
    return Promise.resolve({ id: 'copy-1', ...data } as unknown as Course);
  }

  insertSections(courseId: string, sections: NewSection[], executor?: unknown): Promise<void> {
    this.uow.executorsSeen.push(executor);
    this.sections.push({ courseId, sections });
    return Promise.resolve();
  }

  updateDetails(): Promise<Course> {
    throw new Error('not used by duplication');
  }
  updatePricing(): Promise<Course> {
    throw new Error('not used by duplication');
  }
  setStatus(): Promise<Course> {
    throw new Error('not used by duplication');
  }
}

class FakeReader implements Partial<ICourseReader> {
  constructor(private readonly aggregate: CourseAggregate | null) {}
  findDeepById(): Promise<CourseAggregate | null> {
    return Promise.resolve(this.aggregate);
  }
}

const aggregate = (over: Partial<CourseAggregate> = {}): CourseAggregate => ({
  id: 'crs-1',
  slug: 'kubernetes-in-anger-aaaa1111',
  title: 'Kubernetes in Anger',
  subtitle: null,
  description: 'Why your cluster fell over.',
  language: 'en',
  level: 'ADVANCED',
  instructorId: 'inst-1',
  categoryId: 'cat-1',
  topics: ['kubernetes'],
  priceMinor: 149900,
  listPriceMinor: 199900,
  currency: 'INR',
  thumbnailKey: 'thumbs/crs-1.jpg',
  promoVideoAssetId: 'asset-promo',
  lectureCount: 2,
  totalDurationSeconds: 900,
  sections: [
    {
      title: 'Getting started',
      position: 10,
      lectures: [
        {
          title: 'Why your cluster fell over',
          description: null,
          kind: 'VIDEO',
          position: 10,
          isPreview: true,
          durationSeconds: 600,
          assetId: 'asset-1',
          articleBody: null,
        },
      ],
    },
  ],
  ...over,
});

const build = (source: CourseAggregate | null = aggregate()) => {
  const uow = new FakeUnitOfWork();
  const writer = new FakeWriter(uow);
  const service = new CourseDuplicationService(
    new FakeReader(source) as unknown as ICourseReader,
    writer,
    uow,
  );
  return { service, writer, uow };
};

describe('CourseDuplicationService', () => {
  it('publishes exactly one duplication event, naming both courses', async () => {
    const { service, uow } = build();

    await service.duplicate('crs-1', { id: 'inst-1', role: 'INSTRUCTOR' });

    expect(uow.published).toHaveLength(1);
    expect(uow.published[0]).toMatchObject({
      type: 'catalog.course.duplicated',
      aggregateType: 'Course',
      aggregateId: 'copy-1',
      payload: { courseId: 'copy-1', sourceCourseId: 'crs-1', instructorId: 'inst-1' },
    });
  });

  /**
   * The course and its sections must land in the same transaction. A half-copied course —
   * metadata written, sections missing — is not a state anyone would think to look for, and
   * the instructor would just see an empty duplicate.
   */
  it('writes the course and its sections through the same transaction executor', async () => {
    const { service, uow, writer } = build();

    await service.duplicate('crs-1', { id: 'inst-1', role: 'INSTRUCTOR' });

    expect(uow.executorsSeen).toEqual([EXECUTOR, EXECUTOR]);
    expect(writer.sections[0].courseId).toBe('copy-1');
    expect(writer.sections[0].sections).toHaveLength(1);
  });

  it('refuses an instructor duplicating someone else’s course', async () => {
    const { service, uow } = build();

    await expect(
      service.duplicate('crs-1', { id: 'inst-2', role: 'INSTRUCTOR' }),
    ).rejects.toBeInstanceOf(NotCourseOwnerException);
    expect(uow.published).toHaveLength(0);
  });

  /**
   * An admin may duplicate on someone's behalf, but the copy stays with the original
   * owner — anything else silently moves a course between instructors' dashboards.
   */
  it('lets an admin duplicate, leaving the copy with the original instructor', async () => {
    const { service, writer } = build();

    await service.duplicate('crs-1', { id: 'admin-1', role: 'ADMIN' });

    expect(writer.created[0].instructorId).toBe('inst-1');
  });

  it('404s a source that does not exist', async () => {
    const { service } = build(null);

    await expect(
      service.duplicate('missing', { id: 'inst-1', role: 'INSTRUCTOR' }),
    ).rejects.toBeInstanceOf(CourseNotFoundException);
  });

  it('gives the copy a fresh slug and leaves the source untouched', async () => {
    const source = aggregate();
    const { service, writer } = build(source);

    await service.duplicate('crs-1', { id: 'inst-1', role: 'INSTRUCTOR' });

    expect(writer.created[0].slug).not.toBe(source.slug);
    expect(writer.created[0].title).toBe('Kubernetes in Anger (copy)');
    // Immutable content is referenced, never re-uploaded — the deliberate shallow edge.
    expect(writer.sections[0].sections[0].lectures[0].assetId).toBe('asset-1');
  });
});
