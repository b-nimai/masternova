/** Injection token for the storage provider abstraction. */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface UploadPart {
  partNumber: number;
  etag: string;
}

/** What the provider reports about a part that has actually landed. */
export interface StoredPart extends UploadPart {
  sizeBytes: number;
}

/**
 * Backend-agnostic multipart storage contract. Consumers depend on this, not on the
 * concrete S3/MinIO implementation, so an alternate backend or a fake (in tests) can be
 * swapped in via the {@link STORAGE_PROVIDER} token.
 *
 * **Every method here is implementable by both MinIO and S3.** That is a hard constraint,
 * not an observation: CLAUDE.md §1 L forbids an implementation that throws
 * `NotSupportedError`, because a port whose methods only *sometimes* work is a port that
 * every caller has to know the backend of, which is the coupling it was meant to remove.
 * The line this walks up to is `listParts` — it is S3's `ListParts`, which MinIO
 * implements, and it is why the resume story below is portable rather than S3-specific.
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

  /**
   * The parts the provider has actually received — the authority on upload progress.
   *
   * The API never sees a part land: the browser PUTs each one straight to object storage
   * using a presigned URL. So anything we recorded ourselves would be a guess written by a
   * client that is allowed to crash mid-transfer, and it would be wrong exactly when it is
   * needed. Asking the provider is the only answer that survives a laptop lid closing.
   */
  listParts(key: string, uploadId: string): Promise<StoredPart[]>;

  completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<void>;

  /**
   * Does the assembled object exist? The recovery question, and the reason it is on the
   * port rather than inline in a service.
   *
   * `completeMultipartUpload` is not idempotent — a second call gets `NoSuchUpload`, which
   * is indistinguishable from "the upload was never started". So a process that dies
   * between a successful assemble and its own bookkeeping cannot find out what happened by
   * retrying the assemble; it has to ask whether the object is there. Both MinIO and S3
   * answer this with `HeadObject`.
   */
  objectExists(key: string): Promise<boolean>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
