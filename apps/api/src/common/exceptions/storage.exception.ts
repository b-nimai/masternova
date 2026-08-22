import { InternalServerErrorException } from '@nestjs/common';

/** Raised when the storage backend behaves unexpectedly (e.g. no UploadId returned). */
export class StorageException extends InternalServerErrorException {
  constructor(message = 'Storage operation failed') {
    super(message);
  }
}
