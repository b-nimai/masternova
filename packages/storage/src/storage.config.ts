/**
 * What the storage package needs to know, and nothing about how the host learned it.
 *
 * A `registerAs` factory from `@nestjs/config` would drag a configuration strategy into a
 * package that two different apps mount — and CLAUDE.md §4 already says `process.env` is
 * read in exactly one place per app. So the app reads its own environment and hands the
 * result over this token.
 */
export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');

export interface StorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  /** Reachable from inside the network — `minio:9000` in compose. Used for server-side calls. */
  readonly endpoint: string;
  /**
   * Reachable from the browser — `localhost:9000` in compose. Presigned URLs are signed
   * against this, because an S3 signature covers the host and a URL signed for the internal
   * name is rejected when a browser uses it.
   */
  readonly publicEndpoint: string;
}
