import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { STORAGE_PROVIDER, type IStorageProvider } from '@masternova/storage';
import { entitlementConfig } from '../../config/configuration';
import { InvalidPlaybackTokenException } from '../../common/exceptions';
import type { AccessActor } from './entitlement.service';
import { EntitlementService } from './entitlement.service';
import { PlaybackTokenService } from './playback-token.service';

/**
 * The HLS master playlist key, and the poster beside it.
 *
 * Duplicated as literals rather than imported from the worker: an object key is a
 * wire-level contract between two deployables, exactly like the queue name in
 * `PipelineStatusService`, and importing `apps/worker`'s internals from `apps/api` is the
 * boundary violation §4 forbids one level up. A change to the scheme has to be a migration
 * of existing objects anyway, which is a moment both sides are looking.
 */
const masterPlaylistKey = (assetId: string): string => `video/${assetId}/hls/master.m3u8`;

/**
 * Every route is served under `/api` (`main.ts` sets the global prefix), and this URL is
 * handed to a `<video src>` that will not get a second chance to guess. Same reason
 * identity spells out `/api/auth/refresh` for its cookie path.
 */
const MANIFEST_PATH = '/api/playback/manifest';
const posterKey = (assetId: string): string => `video/${assetId}/poster.jpg`;

export interface PlaybackGrant {
  readonly token: string;
  /** Unix seconds. The player refreshes before this, rather than discovering a 401 mid-stream. */
  readonly expiresAt: number;
  /** Ready to fetch. Carries the token, because a `<video>` src cannot carry a header. */
  readonly manifestUrl: string;
}

export interface PlaybackManifest {
  readonly lectureId: string;
  readonly manifestUrl: string;
  readonly posterUrl: string;
  readonly expiresInSeconds: number;
}

/**
 * Issues playback grants, and redeems them.
 *
 * **Why the manifest URL is presigned per request instead of being a stable CDN path.**
 * Today the manifest lives in MinIO/S3 and the only thing standing between an object and
 * the public internet is the presigned URL's own expiry. That is layer 3 in its current,
 * honest form.
 *
 * **The seam for CloudFront.** When the CDN lands (task 2.x), `objectUrl` below becomes a
 * distribution path plus a `CloudFront-Signature` cookie scoped to `video/{assetId}/*`,
 * and the segment fetches the player makes — which this service never sees, because they go
 * straight from the browser to the edge — start being signed too. That is the gap this
 * layer does not close today and the CDN does: a presigned master playlist protects the
 * manifest, not the three hundred `.ts` segments it names. It is written down rather than
 * papered over, because a security layer everyone believes is present is worse than one
 * everyone knows is missing.
 */
@Injectable()
export class PlaybackService {
  private readonly logger = new Logger(PlaybackService.name);

  constructor(
    private readonly entitlements: EntitlementService,
    private readonly tokens: PlaybackTokenService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(entitlementConfig.KEY) private readonly config: ConfigType<typeof entitlementConfig>,
  ) {}

  /** Layer 1: run the chain, and mint a token only on ALLOW. */
  async grant(lectureId: string, actor: AccessActor, ip?: string): Promise<PlaybackGrant> {
    const { lecture, courseId } = await this.entitlements.authorizeLecture(lectureId, actor);

    // A lecture whose upload never finished has no asset to play. Distinct from a denial:
    // the learner is entitled, the content is simply not there yet.
    if (!lecture.assetId) {
      throw new InvalidPlaybackTokenException('lecture has no playable asset');
    }

    const { token, expiresAt } = this.tokens.issue({
      userId: actor.id,
      lectureId: lecture.id,
      assetId: lecture.assetId,
      ip,
    });

    this.logger.log(
      `playback granted: user ${actor.id} → lecture ${lecture.id} (course ${courseId})`,
    );

    return {
      token,
      expiresAt,
      manifestUrl: `${MANIFEST_PATH}?token=${encodeURIComponent(token)}`,
    };
  }

  /**
   * Layer 2: the token is the credential.
   *
   * **The entitlement chain is deliberately not re-run here.** It ran when the token was
   * minted, at most five minutes ago, and re-running it would put three reads on the path a
   * player hits for every quality switch.
   *
   * **The revocation window is therefore the token's five minutes**, measured from the last
   * grant. On the normal path a refund invalidates the cache key as it commits, so the very
   * next grant is denied and the worst case is one token's lifetime. The two windows only
   * *add up* — cache TTL plus token TTL, ten minutes — when the invalidation itself was
   * lost, which needs a Redis failover between the `DEL` and the read. Stated precisely
   * because "five minutes either way" was the comment here before, and it was wrong: the
   * windows are sequential, not parallel.
   */
  async manifest(token: string, ip?: string): Promise<PlaybackManifest> {
    if (!token) throw new InvalidPlaybackTokenException('missing');

    const claims = this.tokens.verify(token, { ip });
    const remaining = claims.expiresAt - Math.floor(Date.now() / 1000);

    // The object URL never outlives the token that authorized it. A longer-lived presigned
    // URL would be a credential that survives the grant it came from, which is the exact
    // property this whole design exists to remove.
    const expiresIn = Math.min(remaining, this.config.playbackTokenTtlSeconds);

    const [manifestUrl, posterUrl] = await Promise.all([
      this.storage.presignDownload(masterPlaylistKey(claims.assetId), expiresIn),
      this.storage.presignDownload(posterKey(claims.assetId), expiresIn),
    ]);

    return {
      lectureId: claims.lectureId,
      manifestUrl,
      posterUrl,
      expiresInSeconds: expiresIn,
    };
  }
}
