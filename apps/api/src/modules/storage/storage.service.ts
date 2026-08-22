import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ConfigType } from '@nestjs/config';
import { s3Config } from '../../config/configuration';
import { StorageException } from '../../common/exceptions';
import type { IStorageProvider, UploadPart } from './storage.interface';

/**
 * S3/MinIO wrapper for the multipart upload flow.
 *
 * Two clients on purpose: server-side calls (create/complete/abort, bucket setup) go to
 * the INTERNAL endpoint reachable over the Docker network (`minio:9000`); the presigned
 * part URLs handed to the browser are signed with the PUBLIC endpoint (`localhost:9000`)
 * the browser can actually reach — the signature is host-specific, so these must differ.
 */
@Injectable()
export class StorageService implements IStorageProvider, OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
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

  /** Ensure the bucket exists on boot (idempotent). */
  async onModuleInit(): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`created bucket "${this.bucket}"`);
    }
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

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<void> {
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
