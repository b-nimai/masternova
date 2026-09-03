import { Injectable } from '@nestjs/common';
import type { Asset, MediaRendition, PipelineStatus, PrismaClient } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IPipelineRepository, RenditionRecord } from './pipeline.repository.interface';

@Injectable()
export class PrismaPipelineRepository implements IPipelineRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The transaction handle when the caller is inside a Unit of Work, else the base client. */
  private client(executor?: unknown): PrismaClient {
    return (executor as PrismaClient) ?? this.prisma;
  }

  findAsset(assetId: string): Promise<Asset | null> {
    return this.prisma.asset.findUnique({ where: { id: assetId } });
  }

  async recordProbe(assetId: string, durationSeconds: number): Promise<void> {
    await this.prisma.asset.update({
      where: { id: assetId },
      // Rounded: the column is an Int because a fractional second has no consumer — the
      // player seeks in seconds and the sprite grid is built from whole intervals.
      data: { durationSeconds: Math.round(durationSeconds) },
    });
  }

  async upsertRendition(rendition: RenditionRecord, executor?: unknown): Promise<void> {
    const data = {
      kind: rendition.kind,
      storageKey: rendition.storageKey,
      sizeBytes: rendition.sizeBytes,
      width: rendition.width ?? null,
      height: rendition.height ?? null,
      bitrateBps: rendition.bitrateBps ?? null,
    };

    await this.client(executor).mediaRendition.upsert({
      where: { assetId_name: { assetId: rendition.assetId, name: rendition.name } },
      create: { assetId: rendition.assetId, name: rendition.name, ...data },
      update: data,
    });
  }

  findRendition(assetId: string, name: string): Promise<MediaRendition | null> {
    return this.prisma.mediaRendition.findUnique({ where: { assetId_name: { assetId, name } } });
  }

  listRenditions(assetId: string): Promise<MediaRendition[]> {
    return this.prisma.mediaRendition.findMany({ where: { assetId }, orderBy: { name: 'asc' } });
  }

  async setPipeline(
    assetId: string,
    status: PipelineStatus,
    patch: { stage?: string; percent?: number; error?: string | null },
    executor?: unknown,
  ): Promise<void> {
    await this.client(executor).asset.update({
      where: { id: assetId },
      data: {
        pipeline: status,
        ...(patch.stage !== undefined ? { pipelineStage: patch.stage } : {}),
        ...(patch.percent !== undefined ? { pipelinePercent: patch.percent } : {}),
        ...(patch.error !== undefined ? { pipelineError: patch.error } : {}),
      },
    });
  }

  /**
   * `updateMany` with a `percent <` guard, so the write itself is the ratchet.
   *
   * Read-then-compare-then-write would be a check-then-act, and rungs genuinely do finish
   * concurrently — two workers reading 40, both deciding they are ahead, and the slower one
   * committing last. The condition lives in the WHERE clause so the database decides.
   */
  async advanceProgress(assetId: string, percent: number, stage: string): Promise<void> {
    await this.prisma.asset.updateMany({
      where: { id: assetId, pipelinePercent: { lt: percent } },
      data: { pipelinePercent: percent, pipelineStage: stage },
    });
  }
}
