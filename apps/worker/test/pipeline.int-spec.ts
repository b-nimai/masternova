import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import ffmpegPath from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import type { PrismaClient } from '@masternova/db';
import { PrismaUnitOfWork } from '@masternova/db/unit-of-work';
import { UNIT_OF_WORK } from '@masternova/contracts';
import { STORAGE_PROVIDER, StorageModule, type IStorageProvider } from '@masternova/storage';
import { PrismaService } from '../src/prisma/prisma.service';
import { mediaToolsConfig, redisConfig, s3Config } from '../src/config/configuration';
import { MEDIA_TOOLS } from '../src/modules/pipeline/ffmpeg/ffmpeg.interface';
import { MediaToolsService } from '../src/modules/pipeline/ffmpeg/ffmpeg.service';
import { ProbeProcessor } from '../src/modules/pipeline/processors/probe.processor';
import { TranscodeProcessor } from '../src/modules/pipeline/processors/transcode.processor';
import { PackagingProcessor } from '../src/modules/pipeline/processors/packaging.processor';
import { PosterProcessor } from '../src/modules/pipeline/processors/poster.processor';
import { SpriteProcessor } from '../src/modules/pipeline/processors/sprite.processor';
import { JobQueueService } from '../src/modules/pipeline/queue/job-queue.service';
import { PIPELINE_REPOSITORY } from '../src/modules/pipeline/repositories/pipeline.repository.interface';
import { PrismaPipelineRepository } from '../src/modules/pipeline/repositories/pipeline.repository';
import {
  MASTER_RENDITION,
  POSTER_RENDITION,
  masterPlaylistKey,
  posterKey,
  sourceKey,
  spriteImageKey,
  variantPlaylistKey,
} from '../src/modules/pipeline/output-keys';
import type { JobContext } from '../src/modules/pipeline/jobs/base-job.processor';
import { packageJobId } from '../src/modules/pipeline/queue/job-ids';
import { startDatabase } from './setup-db';

/**
 * The pipeline against real ffmpeg, real MinIO, real Redis and real Postgres.
 *
 * The pure pieces — the ladder, the HLS argv, the sprite geometry, the key scheme — are
 * already proven without any of that. What is left is everything a fake cannot tell you:
 * that ffmpeg accepts the argv the Builder produces, that the segments it writes actually
 * land in the bucket, that the master playlist a player fetches is well-formed, and that
 * re-running a stage overwrites its own output rather than duplicating it.
 *
 * `ffmpeg-static` rather than an apt install: requiring a 200 MB system package to run
 * `pnpm test` means the test gets skipped, and a skipped test is not a test.
 */
describe('transcode pipeline (real ffmpeg + MinIO + Postgres)', () => {
  jest.setTimeout(300_000);

  let postgres: StartedPostgreSqlContainer;
  let minio: StartedTestContainer;
  let redis: StartedTestContainer;
  let prisma: PrismaClient;
  let storage: IStorageProvider;

  let probe: ProbeProcessor;
  let transcode: TranscodeProcessor;
  let packaging: PackagingProcessor;
  let poster: PosterProcessor;
  let sprite: SpriteProcessor;
  let queue: JobQueueService;

  let ownerId: string;
  let workDir: string;

  const ctx = (): JobContext => ({ attempt: 1, report: () => Promise.resolve() });

  /**
   * A real, tiny video, synthesised rather than committed.
   *
   * `testsrc` gives a moving pattern with a burnt-in frame counter, so a wrong poster
   * timestamp or a mis-tiled sprite would be visible. 6 seconds at 640x360 encodes in
   * under a second and still produces two HLS segments, which is what makes the segment
   * boundary assertions meaningful.
   */
  const makeSource = async (seconds = 6, size = '640x360') => {
    const path = join(workDir, `source-${Math.random().toString(36).slice(2)}.mp4`);
    execFileSync(ffmpegPath as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${size}:rate=30:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ]);
    return readFile(path);
  };

  /** Seed an asset the way task 1.6 would have left it: bytes uploaded, nothing processed. */
  const seedAsset = async (body: Buffer) => {
    const asset = await prisma.asset.create({
      data: {
        ownerId,
        kind: 'VIDEO',
        status: 'READY',
        storageKey: '',
        contentType: 'video/mp4',
        sizeBytes: BigInt(body.byteLength),
        originalFilename: 'lecture.mp4',
      },
    });
    const key = sourceKey(asset.id);
    await prisma.asset.update({ where: { id: asset.id }, data: { storageKey: key } });
    await storage.putObject(key, body, 'video/mp4');
    return asset.id;
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'mn-pipeline-test-'));

    [minio, redis] = await Promise.all([
      new GenericContainer('minio/minio:RELEASE.2024-10-13T13-34-11Z')
        .withExposedPorts(9000)
        .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
        .withCommand(['server', '/data'])
        .start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);

    /**
     * `127.0.0.1`, not Testcontainers' `localhost`.
     *
     * The statically-linked ffmpeg builds these tests use segfault resolving a *hostname*
     * — glibc's NSS cannot be linked statically, so `getaddrinfo` crashes the process. An
     * IP literal skips resolution entirely. This is an artifact of using a static binary
     * for tests: the worker image installs ffmpeg from apt, which is dynamically linked
     * and resolves `minio` over the Docker network without trouble.
     */
    const host = minio.getHost() === 'localhost' ? '127.0.0.1' : minio.getHost();
    const endpoint = `http://${host}:${minio.getMappedPort(9000)}`;
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_BUCKET = 'masternova-test';
    process.env.S3_ACCESS_KEY = 'minioadmin';
    process.env.S3_SECRET_KEY = 'minioadmin';
    process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env.FFMPEG_PATH = ffmpegPath as string;
    process.env.FFPROBE_PATH = ffprobeInstaller.path;

    await new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    }).send(new CreateBucketCommand({ Bucket: 'masternova-test' }));

    ({ container: postgres, prisma } = await startDatabase());

    const moduleRef = await Test.createTestingModule({
      imports: [
        DiscoveryModule,
        ConfigModule.forRoot({
          isGlobal: true,
          load: [s3Config, mediaToolsConfig, redisConfig],
        }),
        StorageModule.forRootAsync({ inject: [s3Config.KEY], useFactory: (c: never) => c }),
      ],
      providers: [
        ProbeProcessor,
        TranscodeProcessor,
        PackagingProcessor,
        PosterProcessor,
        SpriteProcessor,
        JobQueueService,
        { provide: MEDIA_TOOLS, useClass: MediaToolsService },
        { provide: PIPELINE_REPOSITORY, useClass: PrismaPipelineRepository },
        { provide: PrismaService, useValue: prisma },
        { provide: UNIT_OF_WORK, useValue: new PrismaUnitOfWork(prisma) },
      ],
    }).compile();

    probe = moduleRef.get(ProbeProcessor);
    transcode = moduleRef.get(TranscodeProcessor);
    packaging = moduleRef.get(PackagingProcessor);
    poster = moduleRef.get(PosterProcessor);
    sprite = moduleRef.get(SpriteProcessor);
    queue = moduleRef.get(JobQueueService);
    storage = moduleRef.get<IStorageProvider>(STORAGE_PROVIDER);

    const user = await prisma.user.create({
      data: { email: `pipeline-${Date.now()}@masternova.test`, role: 'INSTRUCTOR' },
    });
    ownerId = user.id;
  }, 300_000);

  afterAll(async () => {
    await queue?.onModuleDestroy();
    await prisma?.$disconnect();
    await rm(workDir, { recursive: true, force: true });
    await Promise.all([postgres?.stop(), minio?.stop(), redis?.stop()]);
  });

  describe('probe', () => {
    it('reads the source and picks a ladder capped at its height', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await probe.process({ assetId }, ctx());

      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.durationSeconds).toBe(6);
      expect(asset.pipeline).toBe('RUNNING');

      // 360 high, so 240p and no more — never upscaled to 720p.
      const tree = await queue.flowTree(packageJobId(assetId));
      const children = (tree?.children ?? []).map((c) => c.job.name);
      expect(children.filter((n) => n === 'media.transcode')).toHaveLength(1);
      expect(children).toContain('media.poster');
      expect(children).toContain('media.sprite');
    });

    it('refuses a non-video asset without retrying', async () => {
      const asset = await prisma.asset.create({
        data: {
          ownerId,
          kind: 'IMAGE',
          status: 'READY',
          storageKey: `image/${Date.now()}/original`,
          contentType: 'image/png',
          sizeBytes: 10n,
          originalFilename: 'thumb.png',
        },
      });
      await expect(probe.process({ assetId: asset.id }, ctx())).rejects.toThrow(/not VIDEO/);
    });
  });

  describe('transcode', () => {
    /**
     * The claim the whole Builder rests on: ffmpeg accepts the argv, and what comes out is
     * a playable HLS rung whose segments are actually in the bucket.
     */
    it('encodes a rung into HLS and uploads every segment plus the playlist', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await probe.process({ assetId }, ctx());
      await transcode.process({ assetId, rung: '240p' }, ctx());

      const rendition = await prisma.mediaRendition.findUniqueOrThrow({
        where: { assetId_name: { assetId, name: '240p' } },
      });
      expect(rendition.kind).toBe('VIDEO');
      expect(rendition.height).toBe(240);
      expect(rendition.width! % 2).toBe(0);
      expect(rendition.sizeBytes).toBeGreaterThan(0n);

      const playlist = await storage.listKeys(`video/${assetId}/hls/240p/`);
      const segments = playlist.filter((k) => k.endsWith('.ts'));
      expect(segments.length).toBeGreaterThan(0);
      expect(playlist).toContain(variantPlaylistKey(assetId, '240p'));

      // Every segment the playlist names must exist — a playlist referencing a missing
      // segment is a player error a learner discovers mid-lecture.
      const url = await storage.presignDownload(variantPlaylistKey(assetId, '240p'));
      const body = await (await fetch(url)).text();
      expect(body).toContain('#EXTM3U');
      expect(body).toContain('#EXT-X-ENDLIST');
      for (const line of body.split('\n').filter((l) => l.endsWith('.ts'))) {
        expect(segments.some((k) => k.endsWith(line.trim()))).toBe(true);
      }
    });

    /**
     * The idempotency claim, run for real: a redelivered job must not produce a second
     * rendition row or a second copy of the segments.
     */
    it('is safe to run twice — same row, same objects, no duplicates', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await probe.process({ assetId }, ctx());

      await transcode.process({ assetId, rung: '240p' }, ctx());
      const firstKeys = await storage.listKeys(`video/${assetId}/hls/240p/`);

      await transcode.process({ assetId, rung: '240p' }, ctx());
      const secondKeys = await storage.listKeys(`video/${assetId}/hls/240p/`);

      expect(secondKeys.sort()).toEqual(firstKeys.sort());
      const rows = await prisma.mediaRendition.findMany({ where: { assetId, name: '240p' } });
      expect(rows).toHaveLength(1);
    });

    it('rejects a rung the ladder no longer contains, without retrying', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await expect(transcode.process({ assetId, rung: '1440p' }, ctx())).rejects.toThrow(
        /not in the current ABR ladder/,
      );
    });
  });

  describe('poster and sprite', () => {
    it('writes a JPEG poster from inside the video, not the first frame', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await poster.process({ assetId, atSeconds: 1 }, ctx());

      const row = await prisma.mediaRendition.findUniqueOrThrow({
        where: { assetId_name: { assetId, name: POSTER_RENDITION } },
      });
      expect(row.kind).toBe('POSTER');

      const url = await storage.presignDownload(posterKey(assetId));
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      // JPEG magic — proof it is a real image and not an ffmpeg error page.
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(bytes.byteLength).toBeGreaterThan(1000);
    });

    it('writes a tiled sprite sheet and a WebVTT that indexes it', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await sprite.process({ assetId, durationSeconds: 6 }, ctx());

      const url = await storage.presignDownload(spriteImageKey(assetId));
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

      const vttUrl = await storage.presignDownload(`video/${assetId}/sprite.vtt`);
      const vtt = await (await fetch(vttUrl)).text();
      expect(vtt.startsWith('WEBVTT')).toBe(true);
      expect(vtt).toContain('#xywh=');
    });
  });

  describe('packaging', () => {
    it('writes a master playlist listing every rung, and marks the asset playable', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await probe.process({ assetId }, ctx());
      await transcode.process({ assetId, rung: '240p' }, ctx());
      await packaging.process({ assetId, rungs: ['240p'] }, ctx());

      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.pipeline).toBe('READY');
      expect(asset.pipelinePercent).toBe(100);

      const url = await storage.presignDownload(masterPlaylistKey(assetId));
      const master = await (await fetch(url)).text();
      expect(master).toContain('#EXTM3U');
      expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=');
      expect(master).toContain('RESOLUTION=');
      expect(master).toContain('240p/index.m3u8');

      await prisma.mediaRendition.findUniqueOrThrow({
        where: { assetId_name: { assetId, name: MASTER_RENDITION } },
      });
    });

    /** The event 1.13's search index and 1.3's instructor email hang off. Exactly one. */
    it('publishes exactly one media.asset.playable, in the same transaction', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await probe.process({ assetId }, ctx());
      await transcode.process({ assetId, rung: '240p' }, ctx());
      await packaging.process({ assetId, rungs: ['240p'] }, ctx());

      const events = await prisma.outboxMessage.findMany({
        where: { type: 'media.asset.playable', aggregateId: assetId },
      });
      expect(events).toHaveLength(1);
      expect((events[0].payload as { masterKey: string }).masterKey).toBe(
        masterPlaylistKey(assetId),
      );
    });

    /**
     * Belt and braces over the flow's ordering. A master listing a rung whose playlist is
     * missing is a player error on the learner's side — the worst place to find out.
     */
    it('refuses to package while a rung is still missing', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      await probe.process({ assetId }, ctx());
      await expect(packaging.process({ assetId, rungs: ['240p', '480p'] }, ctx())).rejects.toThrow(
        /rungs not yet rendered/,
      );
    });
  });

  describe('progress', () => {
    /** A bar that goes backwards reads as a broken upload, which is a support ticket. */
    it('never moves backwards, even when a slower rung reports later', async () => {
      const assetId = await seedAsset(await makeSource(6, '640x360'));
      const repo = new PrismaPipelineRepository(prisma as never);

      await repo.advanceProgress(assetId, 80, 'Encoding 1080p');
      await repo.advanceProgress(assetId, 20, 'Encoding 240p');

      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.pipelinePercent).toBe(80);
      expect(asset.pipelineStage).toBe('Encoding 1080p');
    });
  });
});
