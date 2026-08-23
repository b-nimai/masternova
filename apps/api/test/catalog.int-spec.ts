import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient, Role } from '@masternova/db';
import type { InstructorCourse } from '@masternova/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaCourseRepository } from '../src/modules/catalog/repositories/course.repository';
import {
  atLevel,
  hasTopic,
  inLanguage,
  isFree,
  isPublished,
  priceBetween,
  ratedAtLeast,
  titleMatches,
} from '../src/modules/catalog/specifications/course-specifications';
import type { CourseSpecification } from '../src/modules/catalog/specifications/course-specification';
import { startDatabase } from './setup-db';
import {
  createCategoryTree,
  resetCatalog,
  seedCourseWithStructure,
  seedCourses,
} from './factories/catalog.factory';

/**
 * The catalog's claims that a fake cannot make: that pagination does not lose or repeat a
 * row under concurrent writes, that a specification means the same thing to Postgres as it
 * does in memory, that a duplicate is atomic, and that the invariants are actually in the
 * database rather than merely in a service (CLAUDE.md §6).
 */
describe('catalog (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let app: NestFastifyApplication;

  const request = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    options: {
      payload?: object;
      cookies?: Record<string, string>;
      headers?: Record<string, string>;
    } = {},
  ) => app.inject({ method, url: `/api${url}`, ...options });

  /** Registers, promotes to a role, and signs in — the token has to carry the new role. */
  const signIn = async (role: Role = 'INSTRUCTOR') => {
    const email = `user-${Math.random().toString(36).slice(2, 10)}@masternova.test`;
    const password = 'correct-horse-battery';
    await request('POST', '/auth/register', { payload: { email, password } });
    const user = await prisma.user.update({ where: { email }, data: { role } });
    const login = await request('POST', '/auth/login', { payload: { email, password } });
    const cookies = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
    return { id: user.id, cookies };
  };

  const idsOf = (body: string): string[] =>
    (JSON.parse(body) as { items: { id: string }[] }).items.map((item) => item.id);

  beforeAll(async () => {
    ({ container, prisma } = await startDatabase());
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET as string });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await resetCatalog(prisma);
  });

  describe('authoring', () => {
    it('keeps a new draft off the public catalog and on its owner’s dashboard', async () => {
      const instructor = await signIn();
      const created = await request('POST', '/instructor/courses', {
        payload: { title: 'Kubernetes in Anger' },
        cookies: instructor.cookies,
      });
      expect(created.statusCode).toBe(201);

      const mine = await request('GET', '/instructor/courses', { cookies: instructor.cookies });
      const publicList = await request('GET', '/courses');

      expect(idsOf(mine.body)).toHaveLength(1);
      expect(idsOf(publicList.body)).toHaveLength(0);
    });

    it('publishes, and leaves the event the search indexer will consume', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });

      const published = await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: instructor.cookies,
      });
      expect(published.statusCode).toBe(200);

      // Nothing consumes this yet — task 1.13 will. The event is the seam, so the row is
      // what the test asserts, exactly as identity's suite did before notification existed.
      const event = await prisma.outboxMessage.findFirstOrThrow({
        where: { type: 'catalog.course.published' },
      });
      expect(event.aggregateId).toBe(course.id);
      expect(event.aggregateType).toBe('Course');

      expect(idsOf((await request('GET', '/courses')).body)).toEqual([course.id]);
    });

    /**
     * A cart holding a stale price (task 1.9) cannot ask what the price used to be, so the
     * previous value has to travel on the event.
     */
    it('carries the previous price on the repricing event', async () => {
      const instructor = await signIn();
      const [course] = await seedCourses(prisma, 1, {
        instructorId: instructor.id,
        priceMinor: 49900,
      });

      await request('PATCH', `/instructor/courses/${course.id}/pricing`, {
        payload: { priceMinor: 99900, listPriceMinor: 149900 },
        cookies: instructor.cookies,
      });

      const event = await prisma.outboxMessage.findFirstOrThrow({
        where: { type: 'catalog.course.repriced' },
      });
      expect(event.payload).toMatchObject({ priceMinor: 99900, previousPriceMinor: 49900 });
    });

    /** Archiving is terminal — the one state rule task 1.4 owns; the rest is task 1.5's. */
    it('refuses to publish an archived course', async () => {
      const instructor = await signIn();
      const [course] = await seedCourses(prisma, 1, { instructorId: instructor.id });

      await request('POST', `/instructor/courses/${course.id}/archive`, {
        cookies: instructor.cookies,
      });
      const republish = await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: instructor.cookies,
      });

      expect(republish.statusCode).toBe(409);
    });

    /** `publishedAt` is the catalog's sort key; a republished course must not jump the queue. */
    it('stamps publishedAt on the first publish and never moves it', async () => {
      const instructor = await signIn();
      const [course] = await seedCourses(prisma, 1, {
        instructorId: instructor.id,
        status: 'DRAFT',
        publishedAt: null,
      });

      await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: instructor.cookies,
      });
      const first = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });

      await request('POST', `/instructor/courses/${course.id}/unpublish`, {
        cookies: instructor.cookies,
      });
      await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: instructor.cookies,
      });
      const second = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });

      expect(second.publishedAt).toEqual(first.publishedAt);
    });

    it('gives two courses with the same title distinct slugs', async () => {
      const instructor = await signIn();
      const payload = { title: 'Kubernetes in Anger' };

      const a = await request('POST', '/instructor/courses', {
        payload,
        cookies: instructor.cookies,
      });
      const b = await request('POST', '/instructor/courses', {
        payload,
        cookies: instructor.cookies,
      });

      expect((JSON.parse(a.body) as InstructorCourse).slug).not.toBe(
        (JSON.parse(b.body) as InstructorCourse).slug,
      );
    });

    it('keeps a learner out of every authoring route', async () => {
      const learner = await signIn('LEARNER');

      const list = await request('GET', '/instructor/courses', { cookies: learner.cookies });
      const create = await request('POST', '/instructor/courses', {
        payload: { title: 'Not mine to make' },
        cookies: learner.cookies,
      });

      expect(list.statusCode).toBe(403);
      expect(create.statusCode).toBe(403);
    });

    /**
     * Mirrors `unit-of-work.int-spec.ts` at the catalog level: the event and the state
     * change commit together, so a rolled-back write leaves no event describing something
     * that did not happen.
     */
    it('leaves no outbox row when the write inside the transaction fails', async () => {
      const instructor = await signIn();
      const [existing] = await seedCourses(prisma, 1, { instructorId: instructor.id });

      // A slug collision is a real constraint violation raised mid-transaction, after the
      // event has already been buffered.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.outboxMessage.create({
            data: {
              eventId: 'evt-rollback',
              type: 'catalog.course.created',
              aggregateType: 'Course',
              aggregateId: 'never',
              payload: {},
            },
          });
          await tx.course.create({
            data: {
              slug: existing.slug,
              title: 'Colliding',
              description: '',
              instructorId: instructor.id,
            },
          });
        }),
      ).rejects.toThrow();

      expect(await prisma.outboxMessage.count({ where: { eventId: 'evt-rollback' } })).toBe(0);
    });
  });

  describe('reading', () => {
    it('404s a draft for a stranger and 200s it for its owner', async () => {
      const instructor = await signIn();
      const [course] = await seedCourses(prisma, 1, {
        instructorId: instructor.id,
        status: 'DRAFT',
        publishedAt: null,
      });

      const anonymous = await request('GET', `/courses/${course.slug}`);
      const owner = await request('GET', `/courses/${course.slug}`, {
        cookies: instructor.cookies,
      });

      // 404 and not 403: a 403 would confirm the course exists, which is the leak that
      // composing `visibleTo` into the WHERE clause avoids.
      expect(anonymous.statusCode).toBe(404);
      expect(owner.statusCode).toBe(200);
    });

    it('returns sections and lectures in position order', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 3,
        lecturesPerSection: 4,
        course: { status: 'PUBLISHED', publishedAt: new Date() },
      });

      const detail = JSON.parse((await request('GET', `/courses/${course.slug}`)).body);

      expect(detail.sections.map((s: { position: number }) => s.position)).toEqual([10, 20, 30]);
      expect(detail.sections[0].lectures.map((l: { position: number }) => l.position)).toEqual([
        10, 20, 30, 40,
      ]);
    });

    it('serves the two-level category tree', async () => {
      await createCategoryTree(prisma, 'DevOps', ['Kubernetes', 'Observability']);

      const body = JSON.parse((await request('GET', '/categories')).body);

      expect(body.categories).toHaveLength(1);
      expect(body.categories[0].children).toHaveLength(2);
    });
  });

  describe('pagination', () => {
    /**
     * ⭐ 55 rows, all published in the same instant, paged at 20. The shared `publishedAt`
     * is the point: without `id` in the sort key and in the cursor, the planner is free to
     * break the tie differently on each page and rows appear twice or not at all.
     */
    it('pages 55 rows as 20/20/15 with no gaps and no duplicates', async () => {
      const publishedAt = new Date('2026-06-01T00:00:00.000Z');
      const seeded = await seedCourses(prisma, 55, { publishedAt });

      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];

      do {
        const query: string = cursor
          ? `?limit=20&cursor=${encodeURIComponent(cursor)}`
          : '?limit=20';
        const body = JSON.parse((await request('GET', `/courses${query}`)).body) as {
          items: { id: string }[];
          nextCursor: string | null;
        };
        sizes.push(body.items.length);
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
      } while (cursor);

      expect(sizes).toEqual([20, 20, 15]);
      expect(new Set(seen).size).toBe(55);
      expect([...seen].sort()).toEqual(seeded.map((c) => c.id).sort());
    });

    /**
     * ⭐ The bug keyset pagination exists to prevent, and the evidence for ADR-0015: with
     * `OFFSET`, publishing a course between two page fetches shifts every row down one and
     * the reader sees the last row of page 1 again at the top of page 2.
     */
    it('does not repeat a row when a course is published between two pages', async () => {
      await seedCourses(prisma, 30, (index) => ({
        publishedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      }));

      const first = JSON.parse((await request('GET', '/courses?limit=10')).body) as {
        items: { id: string }[];
        nextCursor: string;
      };

      // Newer than everything seeded, so under OFFSET it would push the whole list down.
      await seedCourses(prisma, 1, { publishedAt: new Date(Date.UTC(2027, 0, 1)) });

      const second = JSON.parse(
        (await request('GET', `/courses?limit=10&cursor=${encodeURIComponent(first.nextCursor)}`))
          .body,
      ) as { items: { id: string }[] };

      const overlap = second.items.filter((item) =>
        first.items.some((seen) => seen.id === item.id),
      );
      expect(overlap).toEqual([]);
    });

    it('rejects a cursor issued for a different sort', async () => {
      await seedCourses(prisma, 3);
      const first = JSON.parse((await request('GET', '/courses?limit=1')).body) as {
        nextCursor: string;
      };

      const replayed = await request(
        'GET',
        `/courses?limit=1&sort=RATING&cursor=${encodeURIComponent(first.nextCursor)}`,
      );

      expect(replayed.statusCode).toBe(400);
    });

    /** Drafts have no publish date; the dashboard sorts by `updatedAt`, which is never null. */
    it('pages an instructor dashboard of drafts', async () => {
      const instructor = await signIn();
      await seedCourses(prisma, 25, {
        instructorId: instructor.id,
        status: 'DRAFT',
        publishedAt: null,
      });

      const first = JSON.parse(
        (await request('GET', '/instructor/courses?limit=20', { cookies: instructor.cookies }))
          .body,
      ) as { items: { id: string }[]; nextCursor: string };
      const second = JSON.parse(
        (
          await request(
            'GET',
            `/instructor/courses?limit=20&cursor=${encodeURIComponent(first.nextCursor)}`,
            { cookies: instructor.cookies },
          )
        ).body,
      ) as { items: { id: string }[]; nextCursor: string | null };

      expect(first.items).toHaveLength(20);
      expect(second.items).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
    });
  });

  /**
   * ⭐ The Specification pattern's one real risk is that `toWhere()` and `isSatisfiedBy()`
   * drift apart — the database says one thing, the in-memory evaluation another, and the
   * entitlement engine (task 1.8) reuses the in-memory half. This is the guard.
   */
  describe('specification / database agreement', () => {
    it('returns exactly the rows the in-memory predicate accepts', async () => {
      await seedCourses(prisma, 24, (index) => ({
        title: index % 3 === 0 ? `Kubernetes deep dive ${index}` : `Postgres tuning ${index}`,
        status: index % 4 === 0 ? 'DRAFT' : 'PUBLISHED',
        publishedAt: index % 4 === 0 ? null : new Date(Date.UTC(2026, 0, 1 + index)),
        level: index % 2 === 0 ? 'BEGINNER' : 'ADVANCED',
        language: index % 5 === 0 ? 'hi' : 'en',
        priceMinor: index % 6 === 0 ? 0 : 49900 + index * 100,
        ratingAverage: 3 + (index % 3),
        topics: index % 2 === 0 ? ['kubernetes'] : ['postgres'],
      }));

      const rows = await prisma.course.findMany();
      const candidates = rows.map((row) => ({
        ...row,
        ratingAverage: Number(row.ratingAverage),
        topics: row.topics,
      }));
      const reader = new PrismaCourseRepository(prisma as unknown as PrismaService);

      const leaves: CourseSpecification[] = [
        isPublished(),
        atLevel('BEGINNER'),
        inLanguage('en'),
        isFree(),
        priceBetween(0, 50_000),
        ratedAtLeast(4),
        titleMatches('kubernetes'),
        hasTopic('postgres'),
      ];

      for (const spec of leaves) {
        const fromDatabase = (await reader.list(spec, { sort: 'NEWEST', limit: 50 })).items
          .map((item) => item.id)
          .sort();
        const fromMemory = candidates
          .filter((candidate) => spec.isSatisfiedBy(candidate))
          .map((candidate) => candidate.id)
          .sort();

        expect({ spec: spec.describe, ids: fromDatabase }).toEqual({
          spec: spec.describe,
          ids: fromMemory,
        });
      }
    });
  });

  describe('duplication', () => {
    it('deep-copies the structure, shares the assets, and starts as a draft', async () => {
      const instructor = await signIn();
      const source = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 3,
        lecturesPerSection: 4,
      });

      const response = await request('POST', `/instructor/courses/${source.id}/duplicate`, {
        payload: {},
        cookies: instructor.cookies,
        headers: { 'idempotency-key': 'dup-1' },
      });
      expect(response.statusCode).toBe(201);
      const copy = JSON.parse(response.body) as InstructorCourse;

      const copied = await prisma.course.findUniqueOrThrow({
        where: { id: copy.id },
        include: { sections: { include: { lectures: true } } },
      });
      const original = await prisma.course.findUniqueOrThrow({
        where: { id: source.id },
        include: { sections: { include: { lectures: true } } },
      });

      expect(copied.status).toBe('DRAFT');
      expect(copied.slug).not.toBe(original.slug);
      expect(copied.sections).toHaveLength(3);
      expect(copied.sections.flatMap((s) => s.lectures)).toHaveLength(12);
      expect(copied.sections[0].id).not.toBe(original.sections[0].id);
      // Immutable content is referenced, not re-uploaded — 12 GB of HLS is the force.
      expect(copied.sections[0].lectures[0].assetId).toBe(original.sections[0].lectures[0].assetId);
    });

    /** ⭐ A double-clicked "Duplicate" button must not leave the instructor two copies. */
    it('creates exactly one copy when the same Idempotency-Key is replayed', async () => {
      const instructor = await signIn();
      const source = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 2,
      });

      const send = () =>
        request('POST', `/instructor/courses/${source.id}/duplicate`, {
          payload: {},
          cookies: instructor.cookies,
          headers: { 'idempotency-key': 'dup-replay' },
        });

      const first = await send();
      const second = await send();

      expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
      expect(await prisma.course.count()).toBe(2);
    });

    it('refuses to duplicate another instructor’s course', async () => {
      const owner = await signIn();
      const other = await signIn();
      const source = await seedCourseWithStructure(prisma, {
        instructorId: owner.id,
        sections: 1,
        lecturesPerSection: 1,
      });

      const response = await request('POST', `/instructor/courses/${source.id}/duplicate`, {
        payload: {},
        cookies: other.cookies,
        headers: { 'idempotency-key': 'dup-forbidden' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  /** The invariant is in the database, not in a service — this is what proves it. */
  it('refuses two sections at the same position in one course', async () => {
    const instructor = await signIn();
    const [course] = await seedCourses(prisma, 1, { instructorId: instructor.id });
    await prisma.section.create({ data: { courseId: course.id, title: 'One', position: 10 } });

    await expect(
      prisma.section.create({ data: { courseId: course.id, title: 'Two', position: 10 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
