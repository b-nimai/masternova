import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { AssetsController } from './assets.controller';
import { UploadSessionService } from './upload-session.service';
import { UploadCompletionService } from './upload-completion.service';
import { UploadReaperService } from './upload-reaper.service';
import { AssetService } from './asset.service';
import { StorageModule } from '../storage/storage.module';
import { MEDIA_REPOSITORY } from './repositories/media.repository.interface';
import { PrismaMediaRepository } from './repositories/media.repository';

/**
 * The `media` bounded context: getting a file from a browser into object storage, and
 * saying when it is safe to use.
 *
 * It does not know what a lecture is. `Lecture.assetId` is a plain string on catalog's
 * side precisely so this module owns the file's lifecycle without catalog owning a
 * relation into it — duplicating a course then shares an asset id rather than copying
 * gigabytes. It does not decide who may *watch* the file either; that is entitlement
 * (1.8), and it is why there is no `getPlaybackUrl` here.
 *
 * It does not transcode. Completing an upload publishes `media.asset.ready` and stops;
 * the pipeline (1.7) is a handler on that event, so this module has no idea it exists.
 */
@Module({
  imports: [StorageModule],
  controllers: [UploadsController, AssetsController],
  providers: [
    UploadSessionService,
    UploadCompletionService,
    UploadReaperService,
    AssetService,
    { provide: MEDIA_REPOSITORY, useClass: PrismaMediaRepository },
  ],
  exports: [AssetService],
})
export class MediaModule {}
