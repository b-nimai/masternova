import { Inject, Injectable } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ConfigType } from '@nestjs/config';
import { s3Config } from '../../config/configuration';
import { StorageException } from '../../common/exceptions';
import type { IStorageProvider, StoredPart, UploadPart } from './storage.interface';

/**
 * S3/MinIO wrapper for the multipart upload flow.
 *
 * **The bucket is not created here.** An earlier version ensured it on boot, which meant
 * the application needed `s3:CreateBucket` in production — a permission a media service has
 * no business holding, and one that turns a typo in `S3_BUCKET` into a silently-created
 * empty bucket instead of a loud failure. Provisioning belongs to infrastructure: the
 * `minio-init` sidecar in compose, Terraform in production. It also made every integration
 * test that boots the app reach for object storage it had no reason to need.
 *
 * Two clients on purpose: server-side calls (create/complete/abort, bucket setup) go to
 * the INTERNAL endpoint reachable over the Docker network (`minio:9000`); the presigned
 * part URLs handed to the browser are signed with the PUBLIC endpoint (`localhost:9000`)
 * the browser can actually reach — the signature is host-specific, so these must differ.
 */
@Injectable()
export class StorageService implements IStorageProvider {
  readonly bucket: string;
  private readonly internal: S3Client;
  private readonly publicClient: S3Client;

  constructor(@Inject(s3Config.KEY) config: ConfigType<typeof s3Config>) {
    this.bucket = config.bucket;
    const credentials = {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    };
    this.internal = new S3Client({
      region: config.region,
      credentials,
      forcePathStyle: true, // MinIO needs path-style (no virtual-host buckets)
      endpoint: config.endpoint,
    });
    this.publicClient = new S3Client({
      region: config.region,
      credentials,
      forcePathStyle: true,
      endpoint: config.publicEndpoint,
    });
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const out = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!out.UploadId) {
      throw new StorageException('S3 did not return an UploadId');
    }
    return out.UploadId;
  }

  /** Presigned URL the browser PUTs a single part to (valid for `expiresIn` seconds). */
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 60 * 60,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  /**
   * Paged on purpose: `ListParts` returns at most 1000 per call and the plan allows up to
   * 10 000, so a single unpaged call would silently report a large upload as incomplete
   * and re-hand the client parts it had already sent.
   */
  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: number | undefined;

    do {
      const out = await this.internal.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker === undefined ? undefined : String(marker),
        }),
      );

      for (const part of out.Parts ?? []) {
        if (part.PartNumber === undefined || !part.ETag) continue;
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          sizeBytes: part.Size ?? 0,
        });
      }

      // Guarded rather than trusted: a provider reporting `IsTruncated` with no marker
      // would yield NaN, which is not `undefined`, so the loop would spin forever
      // re-fetching the same page and growing `parts` without bound — inside a request.
      const next = Number(out.NextPartNumberMarker);
      marker = out.IsTruncated && Number.isFinite(next) ? next : undefined;
    } while (marker !== undefined);

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  /**
   * A miss is `NotFound` / a 404, which the SDK throws rather than returns — so the catch
   * is the answer, not an error path. Anything else (a 403, a network failure) must
   * propagate: treating an unreachable provider as "the object is absent" would let a
   * recovery decide an upload failed when it had actually succeeded.
   */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<void> {
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internal.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
    );
  }
}
