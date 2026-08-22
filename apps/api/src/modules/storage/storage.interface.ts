/** Injection token for the storage provider abstraction. */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface UploadPart {
  partNumber: number;
  etag: string;
}

/**
 * Backend-agnostic multipart storage contract. Consumers depend on this, not on the
 * concrete S3/MinIO implementation, so an alternate backend or a fake (in tests) can be
 * swapped in via the {@link STORAGE_PROVIDER} token.
 */
export interface IStorageProvider {
  readonly bucket: string;
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
