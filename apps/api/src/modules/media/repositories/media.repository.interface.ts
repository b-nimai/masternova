import type {
  Asset,
  AssetKind,
  AssetStatus,
  UploadSession,
  UploadSessionStatus,
} from '@masternova/db';

/**
 * One repository interface for both tables, and one token.
 *
 * The reader/writer split that `catalog` uses earns its keep there because two very
 * different clients exist — a public catalog that only ever reads, and an authoring
 * surface that only ever writes. Media has one client: the upload flow, which reads the
 * session it is about to move. Splitting an interface with no second client is the
 * speculative generality CLAUDE.md §3 forbids, and the ISP argument does not apply to a
 * client that uses all of it.
 *
 * The asset and its session live behind one interface for the same reason they are created
 * in one transaction: `createUpload` writes both or neither, and an interface that could
 * not express that would hand the atomicity problem to every caller.
 */
export const MEDIA_REPOSITORY = Symbol('MEDIA_REPOSITORY');

export interface NewUpload {
  /** Minted by the caller, because the storage key is derived from it before this runs. */
  readonly assetId: string;
  readonly ownerId: string;
  readonly kind: AssetKind;
  readonly contentType: string;
  readonly sizeBytes: bigint;
  readonly originalFilename: string;
  readonly storageKey: string;
  readonly uploadId: string;
  readonly partSize: number;
  readonly partCount: number;
  readonly expiresAt: Date;
}

export type UploadSessionWithAsset = UploadSession & { asset: Asset };

export interface IMediaRepository {
  /** The asset and its session, in one transaction. */
  createUpload(upload: NewUpload, executor?: unknown): Promise<UploadSessionWithAsset>;

  findSession(id: string, executor?: unknown): Promise<UploadSessionWithAsset | null>;
  findAsset(id: string, executor?: unknown): Promise<Asset | null>;

  /**
   * Move a session, conditionally on the state it was read in.
   *
   * `expectedFrom` is the whole point and is not optional. The state machine validates the
   * edge against a row read *outside* the transaction, so writing unconditionally would let
   * the reaper's expire and the browser's complete — each legal from what its caller saw —
   * both land. Returns `null` when the row had moved on, which the caller turns into a 409.
   */
  transition(
    id: string,
    to: UploadSessionStatus,
    expectedFrom: UploadSessionStatus,
    patch: { endedReason?: string; completedAt?: Date },
    executor?: unknown,
  ): Promise<UploadSession | null>;

  setAssetStatus(
    id: string,
    status: AssetStatus,
    patch: { readyAt?: Date },
    executor?: unknown,
  ): Promise<Asset>;

  /** The reaper's queue: live sessions past their expiry, oldest first. */
  findExpired(now: Date, limit: number, executor?: unknown): Promise<UploadSessionWithAsset[]>;

  /**
   * Sessions stuck in COMPLETING because the process assembling them died. Resolved, not
   * aborted — the object may already exist, and only the provider can say.
   */
  findStalledCompleting(
    before: Date,
    limit: number,
    executor?: unknown,
  ): Promise<UploadSessionWithAsset[]>;

  /** The instructor's media library. Assets only — a finished upload is not interesting. */
  listAssets(ownerId: string, kind: AssetKind | undefined, limit: number): Promise<Asset[]>;
}
