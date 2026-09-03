import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { entitlementConfig } from '../../config/configuration';
import { InvalidPlaybackTokenException } from '../../common/exceptions';

/** What the signature covers, and therefore what a stolen token cannot be changed to. */
export interface PlaybackClaims {
  /** Who it was minted for. */
  readonly userId: string;
  /** Which lecture. One token opens one lecture, never a course. */
  readonly lectureId: string;
  /** The asset behind that lecture, so the manifest route needs no second lookup. */
  readonly assetId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** The caller's address, when IP binding is on. */
  readonly ip?: string;
}

const VERSION = 'v1';

/**
 * The second of the three enforcement layers: a short-lived, signed grant to play **one**
 * lecture.
 *
 * **Why a second credential at all, when the guard already ran.** The guard protects the
 * API route. It does not protect the thing the route hands back — a URL to a manifest and
 * a few hundred video segments, which the player fetches directly and which therefore
 * cannot carry an `Authorization` header. Without this the manifest URL is a bearer
 * credential with no expiry: paste it into a group chat and it works forever.
 *
 * **Why not a JWT.** A JWT would bring a library, a header nobody reads, and an algorithm
 * field that has been the source of the two best-known authentication bypasses in the
 * format's history. The claims here are five fixed fields; a versioned HMAC over a
 * canonical string is smaller, has no negotiable algorithm, and is auditable at a glance.
 *
 * **The IP binding is deliberately optional.** Bound, a token is useless to anyone who is
 * not sitting at the same address — which is the property that makes a leaked URL dead on
 * arrival. Unbound, it still expires in five minutes. It is off in development, where a
 * laptop, a container and a proxy present three different addresses for one user, and on in
 * production. Mobile networks re-NAT mid-session, which the five-minute lifetime bounds to
 * one re-issue rather than a broken stream.
 */
@Injectable()
export class PlaybackTokenService {
  constructor(
    @Inject(entitlementConfig.KEY) private readonly config: ConfigType<typeof entitlementConfig>,
  ) {}

  issue(input: { userId: string; lectureId: string; assetId: string; ip?: string }): {
    token: string;
    expiresAt: number;
  } {
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.playbackTokenTtlSeconds;

    const claims: PlaybackClaims = {
      userId: input.userId,
      lectureId: input.lectureId,
      assetId: input.assetId,
      expiresAt,
      ...(this.config.bindTokenToIp && input.ip ? { ip: input.ip } : {}),
    };

    const payload = canonical(claims);
    return { token: `${payload}.${this.sign(payload)}`, expiresAt };
  }

  /**
   * Order matters: **signature first, then expiry, then binding.**
   *
   * Reading any claim before the signature has been checked is reading attacker-controlled
   * input and then trusting it — the shape of every "expiry check on an unverified token"
   * bug. Nothing below the verify call can have been tampered with.
   */
  verify(token: string, presented: { ip?: string }): PlaybackClaims {
    const separator = token.lastIndexOf('.');
    if (separator <= 0) throw new InvalidPlaybackTokenException('malformed');

    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    if (!this.signatureMatches(payload, signature)) {
      throw new InvalidPlaybackTokenException('bad signature');
    }

    const claims = parse(payload);

    if (claims.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new InvalidPlaybackTokenException('expired');
    }

    // Only enforced when the token carries a binding. A token minted while the feature was
    // off must not start failing the moment it is switched on mid-deploy.
    if (claims.ip && claims.ip !== presented.ip) {
      throw new InvalidPlaybackTokenException('address mismatch');
    }

    return claims;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.config.playbackTokenSecret)
      .update(payload)
      .digest('base64url');
  }

  /**
   * Constant-time, and length-checked first.
   *
   * `timingSafeEqual` throws on a length mismatch rather than returning false, so the
   * length has to be compared before it — and a plain `===` on the digests would leak the
   * correct signature one byte at a time to anyone willing to measure.
   */
  private signatureMatches(payload: string, presented: string): boolean {
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(presented);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

/**
 * A fixed field order with a reserved separator, not JSON.
 *
 * JSON has no canonical form: two encoders can order keys differently and produce two
 * signatures for one set of claims. The separator is `|`, and every field it joins is an
 * id or a number that cannot contain one — checked on the way out, because a value that
 * smuggled a separator through could move a claim from one field into another under a
 * signature that stays valid.
 */
function canonical(claims: PlaybackClaims): string {
  const fields = [
    VERSION,
    claims.userId,
    claims.lectureId,
    claims.assetId,
    String(claims.expiresAt),
    claims.ip ?? '',
  ];

  if (fields.some((field) => field.includes('|'))) {
    throw new InvalidPlaybackTokenException('claim contains a reserved character');
  }

  return Buffer.from(fields.join('|')).toString('base64url');
}

function parse(payload: string): PlaybackClaims {
  const fields = Buffer.from(payload, 'base64url').toString('utf8').split('|');
  const [version, userId, lectureId, assetId, expiresAt, ip] = fields;

  // A token signed by a previous version of this scheme verifies, because the secret has
  // not changed — so the version is checked explicitly rather than assumed.
  if (fields.length !== 6 || version !== VERSION) {
    throw new InvalidPlaybackTokenException('unsupported token version');
  }

  const expiry = Number(expiresAt);
  if (!Number.isInteger(expiry)) throw new InvalidPlaybackTokenException('malformed expiry');

  return { userId, lectureId, assetId, expiresAt: expiry, ...(ip ? { ip } : {}) };
}
