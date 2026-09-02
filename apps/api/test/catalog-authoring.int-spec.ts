import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient, Role } from '@masternova/db';
import type { Curriculum, CurriculumCommand, PublishReadiness } from '@masternova/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { startDatabase } from './setup-db';
import {
  resetCatalog,
  seedCourseWithStructure,
  seedPublishableCourse,
} from './factories/catalog.factory';

/**
 * The wizard's claims that a fake cannot make.
 *
 * `curriculum-commands.spec.ts` already proves every command inverts correctly against an
 * in-memory writer. What is left needs a real Postgres: that the `@@unique(position)`
 * constraints survive a reorder, that two concurrent autosaves genuinely serialise rather
 * than merely appearing to, that an undo and its edit commit atomically, and that the
 * rollup counters on the course row track the rows underneath them (CLAUDE.md §6).
 */
describe('catalog authoring (real Postgres)', () => {
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

  const signIn = async (role: Role = 'INSTRUCTOR') => {
    const email = `user-${Math.random().toString(36).slice(2, 10)}@masternova.test`;
    const password = 'correct-horse-battery';
    await request('POST', '/auth/register', { payload: { email, password } });
    const user = await prisma.user.update({ where: { email }, data: { role } });
    const login = await request('POST', '/auth/login', { payload: { email, password } });
    return {
      id: user.id,
      cookies: Object.fromEntries(login.cookies.map((c) => [c.name, c.value])),
    };
  };

  const edit = (
    courseId: string,
    cookies: Record<string, string>,
    expectedVersion: number,
    command: CurriculumCommand,
  ) =>
    request('POST', `/instructor/courses/${courseId}/curriculum`, {
      payload: { expectedVersion, command },
      cookies,
    });

  const curriculumOf = (body: string) => JSON.parse(body) as Curriculum;

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

  describe('the draft state machine', () => {
    it('walks DRAFT -> IN_REVIEW -> PUBLISHED with the reviewer approving', async () => {
      const instructor = await signIn();
      const reviewer = await signIn('ADMIN');
      const course = await seedPublishableCourse(prisma, instructor.id);

      const submitted = await request('POST', `/instructor/courses/${course.id}/submit`, {
        cookies: instructor.cookies,
      });
      expect(submitted.statusCode).toBe(200);
      expect(JSON.parse(submitted.body).status).toBe('IN_REVIEW');

      const published = await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: reviewer.cookies,
      });
      expect(published.statusCode).toBe(200);
      expect(JSON.parse(published.body).status).toBe('PUBLISHED');
    });

    /** If this ever returns 200, IN_REVIEW has quietly become a decorative enum value. */
    it('refuses to publish a course that has not been reviewed', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);

      const published = await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: instructor.cookies,
      });

      expect(published.statusCode).toBe(409);
    });

    it('refuses to let the instructor approve their own course', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);
      await request('POST', `/instructor/courses/${course.id}/submit`, {
        cookies: instructor.cookies,
      });

      const published = await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: instructor.cookies,
      });

      expect(published.statusCode).toBe(403);
      expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).status).toBe(
        'IN_REVIEW',
      );
    });

    it('keeps ARCHIVED terminal', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);
      await request('POST', `/instructor/courses/${course.id}/archive`, {
        cookies: instructor.cookies,
      });

      for (const verb of ['submit', 'unpublish', 'withdraw', 'archive']) {
        const attempt = await request('POST', `/instructor/courses/${course.id}/${verb}`, {
          cookies: instructor.cookies,
        });
        expect([verb, attempt.statusCode]).toEqual([verb, 409]);
      }
    });

    it('refuses every content edit on an archived course', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);
      await request('POST', `/instructor/courses/${course.id}/archive`, {
        cookies: instructor.cookies,
      });
      const { version } = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });

      const patched = await request('PATCH', `/instructor/courses/${course.id}`, {
        payload: { title: 'Sneaking an edit in', expectedVersion: version },
        cookies: instructor.cookies,
      });
      const added = await edit(course.id, instructor.cookies, version, {
        kind: 'ADD_SECTION',
        title: 'Sneaking a section in',
      });

      expect([patched.statusCode, added.statusCode]).toEqual([409, 409]);
    });

    /**
     * A transition bumps the version even though it does not claim one, so an editor
     * holding a pre-archive version cannot pass its claim and write to a course that is now
     * read-only. Without this, the archived check would be a time-of-check race.
     */
    /**
     * Two transitions that are each legal from what their caller read, racing. Applying
     * either unconditionally lets the later one win, and "ARCHIVED is terminal" becomes a
     * comment rather than a guarantee — a course pulled for a rights complaint would go
     * back on sale.
     */
    it('lets only one of two racing transitions land', async () => {
      const instructor = await signIn();
      const reviewer = await signIn('ADMIN');
      const course = await seedPublishableCourse(prisma, instructor.id);
      await request('POST', `/instructor/courses/${course.id}/submit`, {
        cookies: instructor.cookies,
      });

      const [archived, published] = await Promise.all([
        request('POST', `/instructor/courses/${course.id}/archive`, {
          cookies: instructor.cookies,
        }),
        request('POST', `/instructor/courses/${course.id}/publish`, {
          cookies: reviewer.cookies,
        }),
      ]);

      expect([archived.statusCode, published.statusCode].sort()).toEqual([200, 409]);
      const settled = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
      expect(settled.status).toBe(archived.statusCode === 200 ? 'ARCHIVED' : 'PUBLISHED');
    });

    it('invalidates an open tab’s version when the status changes', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);
      const stale = course.version;

      await request('POST', `/instructor/courses/${course.id}/submit`, {
        cookies: instructor.cookies,
      });

      const patched = await request('PATCH', `/instructor/courses/${course.id}`, {
        payload: { title: 'Written against a pre-submit version', expectedVersion: stale },
        cookies: instructor.cookies,
      });

      expect(patched.statusCode).toBe(409);
    });
  });

  describe('the publish gate', () => {
    it('blocks submission and names every missing thing, by step', async () => {
      const instructor = await signIn();
      // Structure only: no subtitle, no category, no thumbnail, no confirmed price.
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });

      const submitted = await request('POST', `/instructor/courses/${course.id}/submit`, {
        cookies: instructor.cookies,
      });

      expect(submitted.statusCode).toBe(422);
      const codes = JSON.parse(submitted.body).details.problems.map(
        (problem: { code: string }) => problem.code,
      );
      expect(codes).toEqual(
        expect.arrayContaining([
          'SUBTITLE_MISSING',
          'DESCRIPTION_TOO_SHORT',
          'CATEGORY_MISSING',
          'THUMBNAIL_MISSING',
          'PRICE_NOT_CONFIRMED',
        ]),
      );
    });

    /**
     * The property the wizard depends on: the checklist and the gate are one list, so
     * "readiness says yes" and "submit succeeds" can never disagree.
     */
    it('agrees with the readiness endpoint, both ways', async () => {
      const instructor = await signIn();
      const incomplete = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });
      const complete = await seedPublishableCourse(prisma, instructor.id);

      const notReady = JSON.parse(
        (
          await request('GET', `/instructor/courses/${incomplete.id}/readiness`, {
            cookies: instructor.cookies,
          }).then((r) => r)
        ).body,
      ) as PublishReadiness;
      const ready = JSON.parse(
        (
          await request('GET', `/instructor/courses/${complete.id}/readiness`, {
            cookies: instructor.cookies,
          })
        ).body,
      ) as PublishReadiness;

      expect(notReady.ready).toBe(false);
      expect(notReady.allowedTransitions).toEqual(['IN_REVIEW', 'ARCHIVED']);
      expect(ready.ready).toBe(true);
      expect(ready.steps.every((step) => step.complete)).toBe(true);

      expect(
        (
          await request('POST', `/instructor/courses/${incomplete.id}/submit`, {
            cookies: instructor.cookies,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await request('POST', `/instructor/courses/${complete.id}/submit`, {
            cookies: instructor.cookies,
          })
        ).statusCode,
      ).toBe(200);
    });

    /**
     * The gate runs again on approval, because the course can be edited while it queues.
     * Without the re-check, a reviewer approves what they saw and publishes what it became.
     */
    it('re-runs on approval, catching a course gutted while in review', async () => {
      const instructor = await signIn();
      const reviewer = await signIn('ADMIN');
      const course = await seedPublishableCourse(prisma, instructor.id);
      await request('POST', `/instructor/courses/${course.id}/submit`, {
        cookies: instructor.cookies,
      });

      const { id: sectionId } = await prisma.section.findFirstOrThrow({
        where: { courseId: course.id },
      });
      const { version } = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
      await edit(course.id, instructor.cookies, version, { kind: 'REMOVE_SECTION', sectionId });

      const published = await request('POST', `/instructor/courses/${course.id}/publish`, {
        cookies: reviewer.cookies,
      });

      expect(published.statusCode).toBe(422);
      expect(
        JSON.parse(published.body).details.problems.map((p: { code: string }) => p.code),
      ).toContain('NO_SECTIONS');
    });
  });

  describe('optimistic concurrency', () => {
    /**
     * The two-open-tabs bug, and the item task 1A's checklist names: two concurrent wizard
     * saves, one wins, the other gets a 409.
     */
    it('lets exactly one of two concurrent autosaves win', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);
      const { version } = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });

      const [tabA, tabB] = await Promise.all([
        request('PATCH', `/instructor/courses/${course.id}`, {
          payload: { title: 'Written by tab A', expectedVersion: version },
          cookies: instructor.cookies,
        }),
        request('PATCH', `/instructor/courses/${course.id}`, {
          payload: { title: 'Written by tab B', expectedVersion: version },
          cookies: instructor.cookies,
        }),
      ]);

      const statuses = [tabA.statusCode, tabB.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      const saved = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
      expect(saved.version).toBe(version + 1);
      // The loser's title is nowhere — that is the whole point. Last-write-wins would have
      // silently discarded the winner's edit instead.
      expect(saved.title).toBe(tabA.statusCode === 200 ? 'Written by tab A' : 'Written by tab B');
    });

    it('tells the loser how far behind it is', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);

      await request('PATCH', `/instructor/courses/${course.id}`, {
        payload: { title: 'First', expectedVersion: 0 },
        cookies: instructor.cookies,
      });
      const stale = await request('PATCH', `/instructor/courses/${course.id}`, {
        payload: { title: 'Second', expectedVersion: 0 },
        cookies: instructor.cookies,
      });

      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(stale.body).details).toEqual({
        expectedVersion: 0,
        currentVersion: 1,
      });
    });

    /** Ten concurrent curriculum commands must produce ten sections and no lost version. */
    it('serialises concurrent curriculum edits on the course row', async () => {
      const instructor = await signIn();
      const course = await seedPublishableCourse(prisma, instructor.id);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          edit(course.id, instructor.cookies, 0, {
            kind: 'ADD_SECTION',
            title: `Racing ${index}`,
          }),
        ),
      );

      // All ten claim version 0, so exactly one may succeed. A second success would mean
      // the claim is not actually atomic.
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);
      expect(await prisma.section.count({ where: { courseId: course.id } })).toBe(2);
    });
  });

  describe('curriculum edits', () => {
    it('reorders sections without tripping the unique position constraint', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 4,
        lecturesPerSection: 1,
      });

      const before = curriculumOf(
        (
          await request('GET', `/instructor/courses/${course.id}/curriculum`, {
            cookies: instructor.cookies,
          })
        ).body,
      );
      const reversed = [...before.sections].reverse().map((section) => section.id);

      const response = await edit(course.id, instructor.cookies, before.version, {
        kind: 'REORDER_SECTIONS',
        sectionIds: reversed,
      });

      expect(response.statusCode).toBe(200);
      expect(curriculumOf(response.body).sections.map((s) => s.id)).toEqual(reversed);
    });

    it('drags a lecture into another section', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 2,
        lecturesPerSection: 2,
      });
      const before = curriculumOf(
        (
          await request('GET', `/instructor/courses/${course.id}/curriculum`, {
            cookies: instructor.cookies,
          })
        ).body,
      );
      const moved = before.sections[0].lectures[1].id;

      const response = await edit(course.id, instructor.cookies, before.version, {
        kind: 'MOVE_LECTURE',
        lectureId: moved,
        toSectionId: before.sections[1].id,
        toIndex: 0,
      });

      const after = curriculumOf(response.body);
      expect(after.sections[0].lectures.map((l) => l.id)).toEqual([
        before.sections[0].lectures[0].id,
      ]);
      expect(after.sections[1].lectures[0].id).toBe(moved);
      expect(new Set(after.sections[1].lectures.map((l) => l.position)).size).toBe(3);
    });

    /** The counters the catalog card renders are recomputed, so they cannot drift. */
    it('keeps the course rollups honest across an add and a remove', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 2,
      });
      const before = curriculumOf(
        (
          await request('GET', `/instructor/courses/${course.id}/curriculum`, {
            cookies: instructor.cookies,
          })
        ).body,
      );

      await edit(course.id, instructor.cookies, before.version, {
        kind: 'ADD_LECTURE',
        sectionId: before.sections[0].id,
        lecture: {
          title: 'Extra',
          description: null,
          kind: 'VIDEO',
          isPreview: false,
          durationSeconds: 120,
          assetId: 'asset-extra',
          articleBody: null,
        },
      });

      const added = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
      expect(added.lectureCount).toBe(3);
      expect(added.totalDurationSeconds).toBe(300 + 301 + 120);

      await edit(course.id, instructor.cookies, added.version, {
        kind: 'REMOVE_LECTURE',
        lectureId: before.sections[0].lectures[0].id,
      });

      const removed = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
      expect(removed.lectureCount).toBe(2);
      expect(removed.totalDurationSeconds).toBe(301 + 120);
    });

    it('refuses to touch a section belonging to another course', async () => {
      const instructor = await signIn();
      const mine = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });
      const theirs = await seedCourseWithStructure(prisma, {
        instructorId: (await signIn()).id,
        sections: 1,
        lecturesPerSection: 1,
      });
      const foreign = await prisma.section.findFirstOrThrow({ where: { courseId: theirs.id } });

      const response = await edit(mine.id, instructor.cookies, 0, {
        kind: 'RENAME_SECTION',
        sectionId: foreign.id,
        title: 'Not yours',
      });

      expect(response.statusCode).toBe(404);
      expect((await prisma.section.findUniqueOrThrow({ where: { id: foreign.id } })).title).toBe(
        'Section 1',
      );
    });

    it('rejects a reorder that is not a permutation', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 3,
        lecturesPerSection: 1,
      });
      const sections = await prisma.section.findMany({ where: { courseId: course.id } });

      const response = await edit(course.id, instructor.cookies, 0, {
        kind: 'REORDER_SECTIONS',
        sectionIds: [sections[0].id, sections[1].id],
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('undo', () => {
    it('brings back a removed section with its lectures and their ids', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 2,
        lecturesPerSection: 2,
      });
      const before = curriculumOf(
        (
          await request('GET', `/instructor/courses/${course.id}/curriculum`, {
            cookies: instructor.cookies,
          })
        ).body,
      );

      await edit(course.id, instructor.cookies, before.version, {
        kind: 'REMOVE_SECTION',
        sectionId: before.sections[0].id,
      });

      const undone = await request('POST', `/instructor/courses/${course.id}/curriculum/undo`, {
        payload: {},
        cookies: instructor.cookies,
        headers: { 'idempotency-key': `undo-${course.id}` },
      });

      expect(undone.statusCode).toBe(200);
      const after = curriculumOf(undone.body);
      // Same ids, not merely the same shape: media (task 1.6) and progress (1.10) hold
      // lecture ids, and an undo that re-keyed the rows would orphan both.
      expect(after.sections.map((s) => s.id)).toEqual(before.sections.map((s) => s.id));
      expect(after.sections[0].lectures.map((l) => l.id)).toEqual(
        before.sections[0].lectures.map((l) => l.id),
      );
      expect(after.canUndo).toBe(false);
    });

    it('walks back through a stack of edits, newest first', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });
      const start = curriculumOf(
        (
          await request('GET', `/instructor/courses/${course.id}/curriculum`, {
            cookies: instructor.cookies,
          })
        ).body,
      );

      const first = curriculumOf(
        (
          await edit(course.id, instructor.cookies, start.version, {
            kind: 'RENAME_SECTION',
            sectionId: start.sections[0].id,
            title: 'Renamed once',
          })
        ).body,
      );
      await edit(course.id, instructor.cookies, first.version, {
        kind: 'ADD_SECTION',
        title: 'Added second',
      });

      const undo = () =>
        request('POST', `/instructor/courses/${course.id}/curriculum/undo`, {
          payload: {},
          cookies: instructor.cookies,
          headers: { 'idempotency-key': `undo-${Math.random()}` },
        });

      expect(curriculumOf((await undo()).body).sections).toHaveLength(1);
      const back = curriculumOf((await undo()).body);

      expect(back.sections[0].title).toBe(start.sections[0].title);
      expect(back.canUndo).toBe(false);
      expect((await undo()).statusCode).toBe(409);
    });

    /**
     * Undo has no `expectedVersion` to make a replay safe, so the `Idempotency-Key` is what
     * stops a double-tapped button popping two edits instead of one.
     */
    it('pops exactly one edit when the same request is replayed', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });

      await edit(course.id, instructor.cookies, 0, { kind: 'ADD_SECTION', title: 'One' });
      await edit(course.id, instructor.cookies, 1, { kind: 'ADD_SECTION', title: 'Two' });

      const undo = () =>
        request('POST', `/instructor/courses/${course.id}/curriculum/undo`, {
          payload: {},
          cookies: instructor.cookies,
          headers: { 'idempotency-key': 'double-tapped' },
        });

      const first = await undo();
      const replay = await undo();

      expect(first.statusCode).toBe(200);
      // Parsed, not compared byte-for-byte: the replay is served from a `jsonb` column,
      // and Postgres does not preserve key order in `jsonb`. Semantically identical is the
      // contract; byte-identical was never promised and is not what a client parses.
      expect(JSON.parse(replay.body)).toEqual(JSON.parse(first.body));
      // Two sections added, one undone. A replay that popped again would leave one.
      expect(await prisma.section.count({ where: { courseId: course.id } })).toBe(2);
    });

    /**
     * `undo` carries no body and identifies its course only by a path param, so hashing the
     * body alone made every course's request hash identical. One key reused across two
     * courses then returned the *first* course's curriculum and popped nothing — a silent
     * 200, which is the worst way for this to fail.
     */
    it('does not let one idempotency key leak across two courses', async () => {
      const instructor = await signIn();
      const a = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });
      const b = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });
      await edit(a.id, instructor.cookies, 0, { kind: 'ADD_SECTION', title: 'In A' });
      await edit(b.id, instructor.cookies, 0, { kind: 'ADD_SECTION', title: 'In B' });

      const undo = (courseId: string) =>
        request('POST', `/instructor/courses/${courseId}/curriculum/undo`, {
          payload: {},
          cookies: instructor.cookies,
          headers: { 'idempotency-key': 'one-key-per-page-load' },
        });

      const first = await undo(a.id);
      const second = await undo(b.id);

      expect(first.statusCode).toBe(200);
      expect(curriculumOf(first.body).courseId).toBe(a.id);
      // Same key, different target: a reused key, not a retry. Rejected loudly rather than
      // silently served A's response.
      expect(second.statusCode).toBe(422);
      expect(await prisma.section.count({ where: { courseId: b.id } })).toBe(2);
    });

    it('records the edit and its inverse in the same transaction as the change', async () => {
      const instructor = await signIn();
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
      });

      await edit(course.id, instructor.cookies, 0, { kind: 'ADD_SECTION', title: 'Logged' });

      const entry = await prisma.courseEdit.findFirstOrThrow({ where: { courseId: course.id } });
      expect(entry.kind).toBe('ADD_SECTION');
      expect(entry.version).toBe(1);
      expect(entry.actorId).toBe(instructor.id);
      expect(entry.inverse).toMatchObject({ kind: 'REMOVE_SECTION' });

      // And the event the search indexer will consume, in that same transaction.
      const event = await prisma.outboxMessage.findFirstOrThrow({
        where: { type: 'catalog.course.curriculum-changed' },
      });
      expect(event.aggregateId).toBe(course.id);
      expect(event.payload).toMatchObject({ edit: 'ADD_SECTION', version: 1 });
    });
  });
});
