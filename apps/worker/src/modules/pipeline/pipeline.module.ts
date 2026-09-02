import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { ConfigType } from '@nestjs/config';
import { UNIT_OF_WORK } from '@masternova/contracts';
import { PrismaUnitOfWork } from '@masternova/db';
import { StorageModule } from '@masternova/storage';
import { s3Config } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from './queue/job-queue.service';
import { PipelineWorker } from './queue/pipeline.worker';
import { JobProcessorRegistry } from './jobs/job-processor.registry';
import { MEDIA_TOOLS } from './ffmpeg/ffmpeg.interface';
import { MediaToolsService } from './ffmpeg/ffmpeg.service';
import { ProbeProcessor } from './processors/probe.processor';
import { TranscodeProcessor } from './processors/transcode.processor';
import { PackagingProcessor } from './processors/packaging.processor';
import { PosterProcessor } from './processors/poster.processor';
import { SpriteProcessor } from './processors/sprite.processor';
import { AssetReadyHandler } from './handlers/asset-ready.handler';
import { PIPELINE_REPOSITORY } from './repositories/pipeline.repository.interface';
import { PrismaPipelineRepository } from './repositories/pipeline.repository';

/**
 * The transcode pipeline: `probe → transcode(fan-out) → package`, with the poster and the
 * sprite as siblings of the ladder.
 *
 * **What it does not know.** It has no idea what a lecture is, or that courses exist. It is
 * started by an event (`media.asset.ready`) and announces its result as another
 * (`media.asset.playable`); catalog and notification react to that without either side
 * importing the other. Adding a consumer is a new `@EventHandler()`, not a change here.
 *
 * `DiscoveryModule` is imported because both the registry and the outbox dispatcher find
 * their members by decorator rather than by injection — the mechanism CLAUDE.md §1 O asks
 * for, so a new stage is a new class and not an edit to this file.
 */
@Module({
  imports: [
    DiscoveryModule,
    StorageModule.forRootAsync({
      inject: [s3Config.KEY],
      useFactory: (config: ConfigType<typeof s3Config>) => config,
    }),
  ],
  providers: [
    JobQueueService,
    PipelineWorker,
    JobProcessorRegistry,

    ProbeProcessor,
    TranscodeProcessor,
    PackagingProcessor,
    PosterProcessor,
    SpriteProcessor,

    AssetReadyHandler,

    { provide: MEDIA_TOOLS, useClass: MediaToolsService },
    { provide: PIPELINE_REPOSITORY, useClass: PrismaPipelineRepository },
    {
      // Same wiring as the API's OutboxModule: the implementation lives in `packages/db`
      // and takes a plain client, so it is constructed rather than instantiated by the
      // container reading decorator metadata it does not have.
      provide: UNIT_OF_WORK,
      useFactory: (prisma: PrismaService) => new PrismaUnitOfWork(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [JobQueueService],
})
export class PipelineModule {}
