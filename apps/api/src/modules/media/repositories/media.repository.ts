import { Injectable } from '@nestjs/common';
import type {
  Asset,
  AssetKind,
  AssetStatus,
  PrismaClient,
  UploadSession,
  UploadSessionStatus,
} from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import { AssetNotFoundException } from '../../../common/exceptions';
import type {
  IMediaRepository,
  NewUpload,
  UploadSessionWithAsset,
} from './media.repository.interface';

@Injectable()
export class PrismaMediaRepository implements IMediaRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(executor?: unknown): PrismaClient {
    return (executor as PrismaClient) ?? this.prisma;
  }

  /**
   * A nested create, so the asset and its session are one statement pair in one
   * transaction. A session pointing at an asset that failed to insert is not a state the
   * rest of this module has any handling for, so it must not be reachable.
   */
  createUpload(upload: NewUpload, executor?: unknown): Promise<UploadSessionWithAsset> {
    return this.client(executor).uploadSession.create({
      data: {
        ownerId: upload.ownerId,
        uploadId: upload.uploadId,
        partSize: upload.partSize,
        partCount: upload.partCount,
        expiresAt: upload.expiresAt,
        asset: {
          create: {
            id: upload.assetId,
            ownerId: upload.ownerId,
            kind: upload.kind,
            contentType: upload.contentType,
            sizeBytes: upload.sizeBytes,
            originalFilename: upload.originalFilename,
            storageKey: upload.storageKey,
          },
        },
      },
      include: { asset: true },
    });
  }

  findSession(id: string, executor?: unknown): Promise<UploadSessionWithAsset | null> {
    return this.client(executor).uploadSession.findUnique({
      where: { id },
      include: { asset: true },
    });
  }

  findAsset(id: string, executor?: unknown): Promise<Asset | null> {
    return this.client(executor).asset.findUnique({ where: { id } });
  }

  /**
   * `updateMany` rather than `update`, because it is the only Prisma call that takes a
   * `where` beyond the primary key and reports how many rows matched. A zero means someone
   * else moved the session first, which is the answer this method exists to give.
   */
  async transition(
    id: string,
    to: UploadSessionStatus,
    expectedFrom: UploadSessionStatus,
    patch: { endedReason?: string; completedAt?: Date },
    executor?: unknown,
  ): Promise<UploadSession | null> {
    const client = this.client(executor);
    const { count } = await client.uploadSession.updateMany({
      where: { id, status: expectedFrom },
      data: { status: to, ...patch },
    });
    if (count === 0) return null;
    return client.uploadSession.findUniqueOrThrow({ where: { id } });
  }

  async setAssetStatus(
    id: string,
    status: AssetStatus,
    patch: { readyAt?: Date },
    executor?: unknown,
  ): Promise<Asset> {
    try {
      return await this.client(executor).asset.update({
        where: { id },
        data: { status, ...patch },
      });
    } catch (error) {
      // Only "record not found" is a 404. A bare `catch` here reported a deadlock, a
      // serialization failure or a dropped connection as "asset does not exist" — a
      // non-retryable answer to a retryable problem, with the real cause never logged.
      if ((error as { code?: string }).code === 'P2025') throw new AssetNotFoundException();
      throw error;
    }
  }

  /**
   * Oldest first and bounded, so one sweep is a predictable amount of work. The reaper
   * calls the provider once per row, and an unbounded batch after an outage would hold a
   * connection open for as long as that took.
   */
  findExpired(now: Date, limit: number, executor?: unknown): Promise<UploadSessionWithAsset[]> {
    return this.client(executor).uploadSession.findMany({
      where: { status: { in: ['CREATED', 'UPLOADING'] }, expiresAt: { lt: now } },
      include: { asset: true },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Sessions stranded mid-assemble by a process that died.
   *
   * A separate query from `findExpired` because the two need different answers: an expired
   * session is aborted, whereas one of these has to be *resolved* — the object may already
   * exist. Without this, a `COMPLETING` row is unreachable by every path (the reaper skipped
   * it, `abort` 409s on it) and its parts stay as invisible billed storage forever.
   */
  findStalledCompleting(
    before: Date,
    limit: number,
    executor?: unknown,
  ): Promise<UploadSessionWithAsset[]> {
    return this.client(executor).uploadSession.findMany({
      where: { status: 'COMPLETING', updatedAt: { lt: before } },
      include: { asset: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  /** READY only: a PENDING asset has no bytes yet and nothing can be attached to it. */
  listAssets(ownerId: string, kind: AssetKind | undefined, limit: number): Promise<Asset[]> {
    return this.prisma.asset.findMany({
      where: { ownerId, status: 'READY', ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
