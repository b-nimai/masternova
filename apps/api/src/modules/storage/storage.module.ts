import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { STORAGE_PROVIDER } from './storage.interface';

@Module({
  providers: [{ provide: STORAGE_PROVIDER, useClass: StorageService }],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
