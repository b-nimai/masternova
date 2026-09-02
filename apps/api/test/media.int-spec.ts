import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient, Role } from '@masternova/db';
import type { AssetView, UploadSessionView } from '@masternova/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UploadReaperService } from '../src/modules/media/upload-reaper.service';
import { UploadCompletionService } from '../src/modules/media/upload-completion.service';
import { STORAGE_PROVIDER, type IStorageProvider } from '../src/modules/storage/storage.interface';
import { startDatabase } from './setup-db';

/**
 * The upload claims a fake cannot make.
 *
 * `upload-plan.spec.ts` and `upload-session.spec.ts` already prove the arithmetic and the
 * edge list with no I/O. What is left is everything that depends on object storage
 * genuinely behaving like object storage: that a part PUT to a presigned URL lands without
 * the API in the path, that `ListParts` reports the gap after a client dies mid-transfer,
 * that a 5 MiB floor is enforced where the provider enforces it, and that completing the
 * same upload twice produces one asset and one event.
 *
 * MinIO rather than a mock, because CLAUDE.md §1 L makes MinIO ≡ S3 a claim this module
 * rests on — and a mock would let a method that only S3 implements pass unnoticed.
 */
describe('media uploads (real Postgres + MinIO)', () => {
  jest.setTimeout(300_000);

  let container: StartedPostgreSqlContainer;
  let minio: StartedTestContainer;
  let prisma: PrismaClient;
  let app: NestFastifyApplication;

  const MiB = 1024 * 1024;

  const request = (
    method: 'GET' | 'POST' | 'DELETE',
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

  const startUpload = async (
    cookies: Record<string, string>,
    sizeBytes: number,
    overrides: Partial<{ kind: string; filename: string; contentType: string }> = {},
  ) => {
    const response = await request('POST', '/media/uploads', {
      cookies,
      payload: {
        kind: 'VIDEO',
        filename: 'lecture.mp4',
        contentType: 'video/mp4',
        sizeBytes: String(sizeBytes),
        ...overrides,
      },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as UploadSessionView };
  };

  /**
   * The part PUT goes straight to MinIO on the presigned URL — no `app.inject`, no API in
   * the path. That is the property under test as much as anything else here: a 10 GB file
   * never occupies a Node process.
   */
  const putPart = async (target: { url: string }, bytes: Buffer) => {
    const response = await fetch(target.url, { method: 'PUT', body: new Uint8Array(bytes) });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  };

  beforeAll(async () => {
    minio = await new GenericContainer('minio/minio:RELEASE.2024-10-13T13-34-11Z')
      .withExposedPorts(9000)
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .withCommand(['server', '/data'])
      .start();

    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    // Both endpoints point at the same mapped port: from the test's perspective there is
    // no Docker network to be inside of, so "internal" and "public" genuinely coincide.
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_PUBLIC_ENDPOINT = endpoint;
    process.env.S3_BUCKET = 'masternova-test';

    // The app no longer creates its bucket on boot — that is infrastructure's job (the
    // `minio-init` sidecar in compose, Terraform in production). So the test plays the
    // part of the provisioner, which is exactly the arrangement production runs.
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
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await Promise.all([container?.stop(), minio?.stop()]);
  });

  beforeEach(async () => {
    await prisma.uploadSession.deleteMany();
    await prisma.asset.deleteMany();
    await prisma.outboxMessage.deleteMany();
  });

  describe('starting an upload', () => {
    it('plans the parts and hands back a signed URL for each', async () => {
      const user = await signIn();
      const { status, body } = await startUpload(user.cookies, 12 * MiB);

      expect(status).toBe(201);
      expect(body.status).toBe('CREATED');
      expect(body.partCount).toBe(2);
      expect(body.parts).toHaveLength(2);
      expect(body.uploadedParts).toEqual([]);
      expect(body.parts[0].url).toContain('X-Amz-Signature');
    });

    it('refuses a content type the kind does not accept', async () => {
      const user = await signIn();
      const response = await request('POST', '/media/uploads', {
        cookies: user.cookies,
        payload: {
          kind: 'VIDEO',
          filename: 'notes.pdf',
          contentType: 'application/pdf',
          sizeBytes: '1024',
        },
      });
      expect(response.statusCode).toBe(415);
    });

    it('refuses a file over the cap for its kind', async () => {
      const user = await signIn();
      const response = await request('POST', '/media/uploads', {
        cookies: user.cookies,
        payload: {
          kind: 'IMAGE',
          filename: 'huge.png',
          contentType: 'image/png',
          sizeBytes: String(64 * MiB),
        },
      });
      expect(response.statusCode).toBe(413);
    });

    /** The key must never contain anything the user typed. */
    it('derives the storage key from the asset id, not the filename', async () => {
      const user = await signIn();
      const { body } = await startUpload(user.cookies, 1024, {
        filename: '../../etc/passwd',
      });
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: body.assetId } });
      expect(asset.storageKey).toBe(`video/${body.assetId}/original`);
      expect(asset.originalFilename).toBe('../../etc/passwd');
    });
  });

  describe('the happy path', () => {
    it('uploads, completes, and marks the asset READY', async () => {
      const user = await signIn();
      const size = 3 * MiB;
      const { body: session } = await startUpload(user.cookies, size);

      await putPart(session.parts[0], Buffer.alloc(size, 1));

      const completed = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `complete-${session.sessionId}` },
        payload: {},
      });

      expect(completed.statusCode).toBe(200);
      const asset = JSON.parse(completed.body) as AssetView;
      expect(asset.status).toBe('READY');
      expect(asset.sizeBytes).toBe(String(size));

      const row = await prisma.uploadSession.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(row.status).toBe('COMPLETED');
    });

    /** The event 1.7's pipeline hangs off. In the same transaction as the state change. */
    it('publishes exactly one media.asset.ready to the outbox', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 2));

      await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `k-${session.sessionId}` },
        payload: {},
      });

      const events = await prisma.outboxMessage.findMany({
        where: { type: 'media.asset.ready' },
      });
      expect(events).toHaveLength(1);
      expect((events[0].payload as { assetId: string }).assetId).toBe(session.assetId);
    });
  });

  /**
   * The reason this module exists. Everything above works on a good connection.
   */
  describe('resuming after the client dies', () => {
    it('reports the parts the provider actually holds, and re-signs only the gap', async () => {
      const user = await signIn();
      const size = 13 * MiB; // 8 MiB + 5 MiB — two parts, both provider-legal.
      const { body: session } = await startUpload(user.cookies, size);
      expect(session.partCount).toBe(2);

      // Send part 1 and then "die" — the client never tells the API anything.
      await putPart(session.parts[0], Buffer.alloc(8 * MiB, 1));

      const resumed = JSON.parse(
        (await request('GET', `/media/uploads/${session.sessionId}`, { cookies: user.cookies }))
          .body,
      ) as UploadSessionView;

      expect(resumed.uploadedParts).toEqual([1]);
      expect(resumed.parts.map((p) => p.partNumber)).toEqual([2]);
      // The observation moved the session, which is how the reaper tells a stalled
      // transfer from one that never started.
      expect(resumed.status).toBe('UPLOADING');

      await putPart(resumed.parts[0], Buffer.alloc(5 * MiB, 2));

      const completed = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `resume-${session.sessionId}` },
        payload: {},
      });
      expect(completed.statusCode).toBe(200);
      expect((JSON.parse(completed.body) as AssetView).status).toBe('READY');
    });

    it('refuses to complete while parts are missing, and names them', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 13 * MiB);
      await putPart(session.parts[0], Buffer.alloc(8 * MiB, 1));

      const response = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `partial-${session.sessionId}` },
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body) as { details: { missingParts: number[] } };
      expect(body.details.missingParts).toEqual([2]);
    });

    /**
     * Caught by us, not by the provider. S3 reports `EntityTooSmall` at complete time and
     * does not say which part — after the instructor has waited out the whole transfer.
     */
    it('rejects a short middle part rather than letting the assemble fail', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 13 * MiB);

      await putPart(session.parts[0], Buffer.alloc(1 * MiB, 1)); // short, and not last
      await putPart(session.parts[1], Buffer.alloc(5 * MiB, 2));

      const response = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `short-${session.sessionId}` },
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).details.partNumber).toBe(1);
    });
  });

  /**
   * Found by `code-review`, all in this task. Each one is a way the module could have been
   * wrong that no happy-path test would have noticed.
   */
  describe('what review caught', () => {
    /**
     * The size cap is otherwise unenforceable: a presigned part URL binds no content
     * length, so a one-byte declaration produces one part — the last part, which skips the
     * 5 MiB floor check — and the client can PUT anything at all to it.
     */
    it('refuses an upload whose bytes do not match the size it was created for', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 1024, {
        kind: 'IMAGE',
        filename: 'tiny.png',
        contentType: 'image/png',
      });

      // Declared 1 KB, sending 3 MB — far past what an IMAGE is allowed to be.
      await putPart(session.parts[0], Buffer.alloc(3 * MiB, 1));

      const response = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `liar-${session.sessionId}` },
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      expect(asset.status).toBe('PENDING');
    });

    /**
     * The grace period is a heuristic, so it can be wrong. When it is — a retry releases a
     * claim whose assemble was still running — the request that actually did the work must
     * still be able to finish, or the object sits in the bucket with the asset PENDING and
     * no `media.asset.ready` ever raised.
     */
    it('still completes when its claim was released mid-assemble', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 12));

      const storage = app.get<IStorageProvider>(STORAGE_PROVIDER);
      const row = await prisma.uploadSession.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      const held = await storage.listParts(asset.storageKey, row.uploadId);
      await storage.completeMultipartUpload(
        asset.storageKey,
        row.uploadId,
        held.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      );

      // The object exists, but a racing retry has released the session back to UPLOADING —
      // exactly the state `finish()` used to refuse.
      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { status: 'UPLOADING' },
      });

      const recovered = await app
        .get(UploadCompletionService)
        .recover({ ...row, status: 'UPLOADING', asset });

      expect(recovered.status).toBe('READY');
      const events = await prisma.outboxMessage.findMany({
        where: { type: 'media.asset.ready' },
      });
      expect(events).toHaveLength(1);
    });

    /**
     * A COMPLETING session was reachable by no path at all: the reaper skipped it and
     * `abort` refused it. A crashed process plus a client that never returns meant parts
     * billed forever, invisible in any bucket listing.
     */
    it('sweeps a session stranded in COMPLETING, which nothing else could reach', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 13));

      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { status: 'COMPLETING', updatedAt: new Date(Date.now() - 30 * 60_000) },
      });

      // Nothing assembled, so the sweep releases it back to a state expiry can collect.
      await app.get(UploadReaperService).sweep();
      expect(
        (await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status,
      ).toBe('UPLOADING');
    });

    /** Polling a session being finalised must not 500 because ListParts says NoSuchUpload. */
    it('reports status without touching the provider while an assemble is in flight', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 14));

      const storage = app.get<IStorageProvider>(STORAGE_PROVIDER);
      const row = await prisma.uploadSession.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      const held = await storage.listParts(asset.storageKey, row.uploadId);
      // Consume the multipart upload, so ListParts would now fail.
      await storage.completeMultipartUpload(
        asset.storageKey,
        row.uploadId,
        held.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      );
      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { status: 'COMPLETING' },
      });

      const response = await request('GET', `/media/uploads/${session.sessionId}`, {
        cookies: user.cookies,
      });
      expect(response.statusCode).toBe(200);
      expect((JSON.parse(response.body) as UploadSessionView).status).toBe('COMPLETING');
    });

    /** The sweep must count what it claimed, not what it looked at. */
    it('does not count a session another replica already claimed', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const reaper = app.get(UploadReaperService);
      const [a, b] = [await reaper.sweep(), await reaper.sweep()];
      expect(a + b).toBe(1);
    });
  });

  /** The DoD's idempotency requirement: this endpoint is reachable from a client retry. */
  describe('idempotency and concurrency', () => {
    it('completes exactly once when the same request arrives ten times at once', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 7));

      const attempts = await Promise.all(
        Array.from({ length: 10 }, () =>
          request('POST', `/media/uploads/${session.sessionId}/complete`, {
            cookies: user.cookies,
            // Distinct keys on purpose: this asserts the *domain* is idempotent, not that
            // the idempotency interceptor deduped the calls for it.
            headers: { 'idempotency-key': `race-${Math.random()}` },
            payload: {},
          }),
        ),
      );

      const ok = attempts.filter((a) => a.statusCode === 200);
      expect(ok).toHaveLength(1);
      expect(attempts.filter((a) => a.statusCode === 409)).toHaveLength(9);

      const events = await prisma.outboxMessage.findMany({
        where: { type: 'media.asset.ready' },
      });
      expect(events).toHaveLength(1);

      const assets = await prisma.asset.findMany({ where: { status: 'READY' } });
      expect(assets).toHaveLength(1);
    });

    it('replays a stored response when the same Idempotency-Key is retried', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 3));

      const key = `retry-${session.sessionId}`;
      const first = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': key },
        payload: {},
      });
      const second = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': key },
        payload: {},
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // Parsed, not string-compared: the stored response is JSON round-tripped, so key
      // order differs while the value is identical.
      expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    });
  });

  /**
   * The failure the COMPLETING state was introduced to survive: the process died between
   * a successful assemble and its own bookkeeping. Retrying the assemble cannot answer
   * what happened — the provider says `NoSuchUpload` whether it succeeded or never ran —
   * so recovery asks whether the object exists instead.
   */
  describe('recovering a crashed assemble', () => {
    it('finishes an upload whose object exists but whose bookkeeping never ran', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 9));

      // Assemble the object out of band, then leave the row exactly as a process that died
      // immediately afterwards would have left it: COMPLETING, and stale.
      const storage = app.get<IStorageProvider>(STORAGE_PROVIDER);
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      const row = await prisma.uploadSession.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      const held = await storage.listParts(asset.storageKey, row.uploadId);
      await storage.completeMultipartUpload(
        asset.storageKey,
        row.uploadId,
        held.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      );
      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { status: 'COMPLETING', updatedAt: new Date(Date.now() - 10 * 60_000) },
      });

      const response = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `recover-${session.sessionId}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect((JSON.parse(response.body) as AssetView).status).toBe('READY');
      const events = await prisma.outboxMessage.findMany({
        where: { type: 'media.asset.ready' },
      });
      expect(events).toHaveLength(1);
    });

    /** No object means the assemble never landed — hand the session back to the client. */
    it('releases a stale COMPLETING session whose object was never assembled', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 10));

      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { status: 'COMPLETING', updatedAt: new Date(Date.now() - 10 * 60_000) },
      });

      const first = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `rel-a-${session.sessionId}` },
        payload: {},
      });
      expect(first.statusCode).toBe(409);
      expect(
        (await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status,
      ).toBe('UPLOADING');

      // Released, so the client's retry now succeeds rather than being stuck forever.
      const retry = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `rel-b-${session.sessionId}` },
        payload: {},
      });
      expect(retry.statusCode).toBe(200);
    });

    /** A fresh COMPLETING belongs to a live request and must not be touched. */
    it('reports a conflict without disturbing an assemble that is in flight', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 11));
      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { status: 'COMPLETING' },
      });

      const response = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `inflight-${session.sessionId}` },
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      // Unchanged — stealing this claim is what broke the concurrent-completion case.
      expect(
        (await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.sessionId } })).status,
      ).toBe('COMPLETING');
    });
  });

  describe('ending badly', () => {
    it('aborts an upload the instructor cancelled', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);

      const response = await request('DELETE', `/media/uploads/${session.sessionId}`, {
        cookies: user.cookies,
      });
      expect(response.statusCode).toBe(204);

      const row = await prisma.uploadSession.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(row.status).toBe('ABORTED');
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      expect(asset.status).toBe('FAILED');
    });

    it('refuses to abort an upload that already completed', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 4));
      await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `done-${session.sessionId}` },
        payload: {},
      });

      const response = await request('DELETE', `/media/uploads/${session.sessionId}`, {
        cookies: user.cookies,
      });
      expect(response.statusCode).toBe(409);

      // The asset must still be READY. If this flips to FAILED, a published lecture's
      // media has just been marked broken by a stray cancel.
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      expect(asset.status).toBe('READY');
    });

    /** An abandoned multipart upload is billed storage that no bucket listing shows. */
    it('reaps a session whose expiry has passed', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const reaped = await app.get(UploadReaperService).sweep();
      expect(reaped).toBe(1);

      const row = await prisma.uploadSession.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(row.status).toBe('EXPIRED');
      expect(row.endedReason).toBe('expired');
    });

    /**
     * The race the claim-then-abort ordering exists to prevent: a reaper sweep must never
     * mark a completed upload's asset FAILED, or a paid lecture 404s for every learner.
     */
    it('never reaps an upload that completed first', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 5));
      await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `won-${session.sessionId}` },
        payload: {},
      });

      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect(await app.get(UploadReaperService).sweep()).toBe(0);
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      expect(asset.status).toBe('READY');
    });

    it('refuses to complete an expired session', async () => {
      const user = await signIn();
      const { body: session } = await startUpload(user.cookies, 2 * MiB);
      await putPart(session.parts[0], Buffer.alloc(2 * MiB, 6));
      await prisma.uploadSession.update({
        where: { id: session.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request('POST', `/media/uploads/${session.sessionId}/complete`, {
        cookies: user.cookies,
        headers: { 'idempotency-key': `gone-${session.sessionId}` },
        payload: {},
      });
      expect(response.statusCode).toBe(410);
    });
  });

  describe('ownership', () => {
    it('hides another instructor’s upload session behind a 404', async () => {
      const owner = await signIn();
      const stranger = await signIn();
      const { body: session } = await startUpload(owner.cookies, 2 * MiB);

      const response = await request('GET', `/media/uploads/${session.sessionId}`, {
        cookies: stranger.cookies,
      });
      // 404 rather than 403: a 403 would confirm the session exists.
      expect(response.statusCode).toBe(404);
    });

    it('lists only READY assets, and only the caller’s own', async () => {
      const owner = await signIn();
      const stranger = await signIn();

      const { body: done } = await startUpload(owner.cookies, 2 * MiB);
      await putPart(done.parts[0], Buffer.alloc(2 * MiB, 8));
      await request('POST', `/media/uploads/${done.sessionId}/complete`, {
        cookies: owner.cookies,
        headers: { 'idempotency-key': `lib-${done.sessionId}` },
        payload: {},
      });
      // A second upload left PENDING — it has no bytes and must not be listable.
      await startUpload(owner.cookies, 2 * MiB);

      const mine = JSON.parse(
        (await request('GET', '/media/assets', { cookies: owner.cookies })).body,
      ) as AssetView[];
      expect(mine).toHaveLength(1);
      expect(mine[0].id).toBe(done.assetId);

      const theirs = JSON.parse(
        (await request('GET', '/media/assets', { cookies: stranger.cookies })).body,
      ) as AssetView[];
      expect(theirs).toHaveLength(0);
    });
  });
});
