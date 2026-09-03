import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Course, PrismaClient, Role, User } from '@masternova/db';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import { EntitlementService } from '../src/modules/entitlement/entitlement.service';
import { entitlementCacheKey } from '../src/modules/entitlement/repositories/cached-entitlement.repository';
import { startDatabase } from './setup-db';
import { createUser, seedCourseWithStructure } from './factories/catalog.factory';

/**
 * The claims a unit test cannot make about the entitlement engine.
 *
 * `entitlement-engine.spec.ts` already proves the rules, and it does so with no I/O — that
 * is the point of a chain over a pure context. What is left is everything the rules cannot
 * see: that the guard actually refuses the route, that a cached decision is genuinely
 * dropped by a revoke in Postgres rather than by a mock that agreed to be dropped, that a
 * playback token survives the round trip through HTTP, and that the manifest URL it buys is
 * a real presigned object in a real bucket.
 *
 * Redis is a real container rather than a fake, because the cache's whole purpose is to be
 * consulted by a *different* request than the one that filled it, and an in-process map
 * cannot fail the way a network round trip can.
 */
describe('entitlement (real Postgres + Redis + MinIO)', () => {
  jest.setTimeout(300_000);

  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let minio: StartedTestContainer;
  let prisma: PrismaClient;
  let app: NestFastifyApplication;
  let redis: Redis;
  let entitlements: EntitlementService;
  let uow: UnitOfWork;

  const request = (
    method: 'GET' | 'POST',
    url: string,
    options: { cookies?: Record<string, string>; payload?: object } = {},
  ) => app.inject({ method, url: `/api${url}`, ...options });

  const signIn = async (role: Role = 'LEARNER') => {
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

  /** A published, paid course with two lectures — the first a preview, the second not. */
  const publishedCourse = async (instructor: User): Promise<Course> => {
    const course = await seedCourseWithStructure(prisma, {
      instructorId: instructor.id,
      sections: 1,
      lecturesPerSection: 2,
      course: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        priceMinor: 249900,
        priceSetAt: new Date(),
      },
    });
    return course;
  };

  const lecturesOf = (courseId: string) =>
    prisma.lecture.findMany({
      where: { section: { courseId } },
      orderBy: { position: 'asc' },
    });

  beforeAll(async () => {
    [redisContainer, minio] = await Promise.all([
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
      new GenericContainer('minio/minio:RELEASE.2024-10-13T13-34-11Z')
        .withExposedPorts(9000)
        .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
        .withCommand(['server', '/data'])
        .start(),
    ]);

    process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_PUBLIC_ENDPOINT = endpoint;
    process.env.S3_BUCKET = 'masternova-test';

    await new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    }).send(new CreateBucketCommand({ Bucket: 'masternova-test' }));

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

    redis = app.get<Redis>(REDIS_CLIENT);
    entitlements = app.get(EntitlementService);

    // The client is deliberately `lazyConnect` with `enableOfflineQueue: false`, so a
    // command issued before the socket is up fails rather than queueing — which is the
    // right production behaviour (everything degrades to Postgres) and a race in a test
    // that expects to talk to Redis on the first `beforeEach`.
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        redis.once('ready', resolve);
        redis.once('error', reject);
      });
    }
    uow = app.get<UnitOfWork>(UNIT_OF_WORK);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await Promise.all([container?.stop(), redisContainer?.stop(), minio?.stop()]);
  });

  beforeEach(async () => {
    await prisma.entitlement.deleteMany();
    await prisma.course.deleteMany();
    await prisma.user.deleteMany();
    await redis.flushall();
  });

  describe('the guard refuses the route', () => {
    it('denies a stranger a playback grant, with a reason a UI can branch on', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [, paid] = await lecturesOf(course.id);
      const learner = await signIn();

      const response = await request('GET', `/playback/lectures/${paid.id}/grant`, {
        cookies: learner.cookies,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ details: { reason: 'NO_ENTITLEMENT' } });
    });

    it('grants the same lecture once the learner has bought it', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [, paid] = await lecturesOf(course.id);
      const learner = await signIn();

      await entitlements.grant({
        userId: learner.id,
        courseId: course.id,
        source: 'PURCHASE',
        orderId: 'order-1',
      });

      const response = await request('GET', `/playback/lectures/${paid.id}/grant`, {
        cookies: learner.cookies,
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).token).toEqual(expect.any(String));
    });

    it('lets anyone play a free preview lecture', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [preview] = await lecturesOf(course.id);
      const learner = await signIn();

      const response = await request('GET', `/playback/lectures/${preview.id}/grant`, {
        cookies: learner.cookies,
      });

      expect(response.statusCode).toBe(200);
    });

    it('answers 404 for a lecture that does not exist, not 403', async () => {
      const learner = await signIn();
      const response = await request('GET', '/playback/lectures/nope/grant', {
        cookies: learner.cookies,
      });
      expect(response.statusCode).toBe(404);
    });

    it('requires a session at all', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [preview] = await lecturesOf(course.id);

      expect((await request('GET', `/playback/lectures/${preview.id}/grant`)).statusCode).toBe(401);
    });
  });

  describe('the cache, and what invalidates it', () => {
    it('populates the key on the first decision and reuses it', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const learner = await signIn();

      await entitlements.grant({ userId: learner.id, courseId: course.id, source: 'PURCHASE' });
      await entitlements.decideForCourse(course.id, { id: learner.id, role: 'LEARNER' });

      const cached = await redis.get(entitlementCacheKey(learner.id, course.id));
      expect(cached).toContain('ACTIVE');
    });

    /**
     * The whole point of the Decorator. A refund that leaves a stale ALLOW in Redis is a
     * learner who keeps watching content they were paid back for.
     */
    it('stops allowing access the moment a refund revokes it', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [, paid] = await lecturesOf(course.id);
      const learner = await signIn();
      const actor = { id: learner.id, role: 'LEARNER' as const };

      await entitlements.grant({
        userId: learner.id,
        courseId: course.id,
        source: 'PURCHASE',
        orderId: 'order-7',
      });
      expect((await entitlements.decideForLecture(paid.id, actor)).verdict).toBe('ALLOW');

      const revoked = await entitlements.revokeByOrder('order-7', 'refund rzp_1');
      expect(revoked).toEqual([{ userId: learner.id, courseId: course.id }]);

      expect(await redis.get(entitlementCacheKey(learner.id, course.id))).toBeNull();
      const after = await entitlements.decideForLecture(paid.id, actor);
      expect(after.verdict).toBe('DENY');
      expect(after.reason).toBe('ENTITLEMENT_REVOKED');
    });

    /** A revoked learner loses the preview too — DENY beats ALLOW, through the real stack. */
    it('locks a refunded learner out of the preview lecture as well', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [preview] = await lecturesOf(course.id);
      const learner = await signIn();

      await entitlements.grant({ userId: learner.id, courseId: course.id, source: 'PURCHASE' });
      await entitlements.revoke(learner.id, course.id, 'chargeback');

      const response = await request('GET', `/playback/lectures/${preview.id}/grant`, {
        cookies: learner.cookies,
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        details: { reason: 'ENTITLEMENT_REVOKED' },
      });
    });
  });

  describe('writes that join the caller’s transaction', () => {
    /**
     * The ordering bug review caught. The entitlement must commit with the order that paid
     * for it — but the cache must be dropped *after* that commit, never inside it: a DEL
     * issued mid-transaction is followed by a concurrent read that finds the pre-write row
     * still in Postgres and re-caches it for the full five minutes, so the refund silently
     * keeps working. These prove both halves: nothing is forgotten early, everything is
     * forgotten once it commits.
     */
    it('revokes and forgets in the right order', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const learner = await signIn();
      const actor = { id: learner.id, role: 'LEARNER' as const };
      const key = entitlementCacheKey(learner.id, course.id);

      await entitlements.grant({
        userId: learner.id,
        courseId: course.id,
        source: 'PURCHASE',
        orderId: 'order-tx',
      });
      expect((await entitlements.decideForCourse(course.id, actor)).verdict).toBe('ALLOW');
      expect(await redis.get(key)).not.toBeNull();

      const seenInside: (string | null)[] = [];
      const revoked = await entitlements.revokeByOrderInTransaction(
        'order-tx',
        'refund rzp_2',
        uow,
        async () => {
          // Still inside the transaction: the row is not durable, so the key must survive.
          seenInside.push(await redis.get(key));
        },
      );

      expect(seenInside[0]).not.toBeNull();
      expect(revoked).toEqual([{ userId: learner.id, courseId: course.id }]);
      expect(await redis.get(key)).toBeNull();
      expect((await entitlements.decideForCourse(course.id, actor)).verdict).toBe('DENY');
    });

    it('rolls the entitlement back with the transaction that failed', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const learner = await signIn();

      await expect(
        entitlements.grantInTransaction(
          { userId: learner.id, courseId: course.id, source: 'PURCHASE', orderId: 'order-x' },
          uow,
          async () => {
            throw new Error('the order failed after the grant');
          },
        ),
      ).rejects.toThrow('the order failed after the grant');

      // No entitlement, because the order it belonged to never happened. That atomicity is
      // the entire reason `grantInTransaction` takes the Unit of Work.
      expect(await prisma.entitlement.findMany({ where: { userId: learner.id } })).toHaveLength(0);
    });
  });

  describe('granting is idempotent', () => {
    /**
     * `order.paid` is delivered at least once — the outbox is explicitly allowed to deliver
     * it twice. Two rows would mean a revoke that finds one and leaves the other.
     */
    it('produces one row when the same purchase arrives fifty times at once', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const learner = await signIn();

      await Promise.all(
        Array.from({ length: 50 }, () =>
          entitlements
            .grant({
              userId: learner.id,
              courseId: course.id,
              source: 'PURCHASE',
              orderId: 'order-9',
            })
            // An upsert race surfaces as a unique-constraint violation on the insert half;
            // the row it collided with is the one that was wanted, so losing is success.
            .catch(() => undefined),
        ),
      );

      const rows = await prisma.entitlement.findMany({ where: { userId: learner.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('ACTIVE');
    });

    it('re-activates a revoked row when the learner buys again', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const learner = await signIn();

      await entitlements.grant({ userId: learner.id, courseId: course.id, source: 'PURCHASE' });
      await entitlements.revoke(learner.id, course.id, 'refund');
      await entitlements.grant({
        userId: learner.id,
        courseId: course.id,
        source: 'PURCHASE',
        orderId: 'order-2',
      });

      const rows = await prisma.entitlement.findMany({ where: { userId: learner.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'ACTIVE', revokedAt: null, revokedReason: null });
    });

    it('revoking access nobody has is a no-op, not an error', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const learner = await signIn();

      await expect(entitlements.revoke(learner.id, course.id, 'refund')).resolves.toBeUndefined();
      // And twice, because the webhook that calls it retries.
      await expect(entitlements.revoke(learner.id, course.id, 'refund')).resolves.toBeUndefined();
    });
  });

  describe('the playback token, end to end', () => {
    it('buys a presigned manifest URL without a session', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [preview] = await lecturesOf(course.id);
      const learner = await signIn();

      const granted = await request('GET', `/playback/lectures/${preview.id}/grant`, {
        cookies: learner.cookies,
      });
      const { manifestUrl } = JSON.parse(granted.body);

      // **Followed exactly as returned**, not rebuilt. Asserting only that it contained the
      // token hid a real bug: the URL omitted the `/api` global prefix, so a real
      // `<video src={manifestUrl}>` 404'd while this test passed by constructing the path
      // itself. Deliberately no cookies — the token is the credential, which is the entire
      // reason this route exists.
      const manifest = await app.inject({ method: 'GET', url: manifestUrl });

      expect(manifest.statusCode).toBe(200);
      const body = JSON.parse(manifest.body);
      expect(body.lectureId).toBe(preview.id);
      expect(body.manifestUrl).toContain('master.m3u8');
      expect(body.manifestUrl).toContain('X-Amz-Signature');
      expect(body.expiresInSeconds).toBeLessThanOrEqual(300);
    });

    it('refuses a tampered token', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await publishedCourse(instructor);
      const [preview] = await lecturesOf(course.id);
      const learner = await signIn();

      const granted = await request('GET', `/playback/lectures/${preview.id}/grant`, {
        cookies: learner.cookies,
      });
      const { token } = JSON.parse(granted.body);

      const forged = `${token.slice(0, -4)}AAAA`;
      const response = await request(
        'GET',
        `/playback/manifest?token=${encodeURIComponent(forged)}`,
      );

      expect(response.statusCode).toBe(401);
    });

    it('refuses a request with no token at all', async () => {
      expect((await request('GET', '/playback/manifest')).statusCode).toBe(401);
    });
  });

  describe('staff', () => {
    it('lets an instructor play their own unpublished draft', async () => {
      const instructor = await signIn('INSTRUCTOR');
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 2,
        course: { status: 'DRAFT', publishedAt: null, priceMinor: 249900, priceSetAt: new Date() },
      });
      const [, paid] = await lecturesOf(course.id);

      const response = await request('GET', `/playback/lectures/${paid.id}/grant`, {
        cookies: instructor.cookies,
      });
      expect(response.statusCode).toBe(200);
    });

    /** Staff skip the entitlement read entirely — nothing should be cached for them. */
    it('answers for staff without touching the entitlement cache', async () => {
      const instructor = await signIn('INSTRUCTOR');
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
        course: { status: 'PUBLISHED', publishedAt: new Date(), priceSetAt: new Date() },
      });

      await entitlements.decideForCourse(course.id, { id: instructor.id, role: 'INSTRUCTOR' });

      expect(await redis.get(entitlementCacheKey(instructor.id, course.id))).toBeNull();
    });

    it('hides another instructor’s draft from a learner', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 2,
        course: { status: 'DRAFT', publishedAt: null, priceSetAt: new Date(), priceMinor: 0 },
      });
      const [preview] = await lecturesOf(course.id);
      const learner = await signIn();

      const response = await request('GET', `/playback/lectures/${preview.id}/grant`, {
        cookies: learner.cookies,
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        details: { reason: 'COURSE_NOT_PUBLISHED' },
      });
    });
  });
});
