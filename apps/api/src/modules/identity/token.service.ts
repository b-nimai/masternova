import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ConfigType } from '@nestjs/config';
import type { Role } from '@masternova/db';
import { identityConfig } from '../../config/configuration';

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  /** The session this token belongs to, so a revoked device can be traced from a token. */
  sid: string;
}

/**
 * Mints and verifies credentials. It knows nothing about users, sessions or requests —
 * it turns claims into strings and strings back into claims.
 *
 * Kept separate from {@link SessionService} because the two change for different reasons:
 * this one changes when the crypto or the token format changes, that one when the
 * lifecycle rules do (CLAUDE.md §1 S).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(identityConfig.KEY)
    private readonly config: ConfigType<typeof identityConfig>,
  ) {}

  /**
   * Short-lived, signed, and carrying just enough to authorize without a database read.
   *
   * A JWT cannot be withdrawn before it expires, so this TTL *is* the revocation window:
   * revoking a session stops refreshes immediately but leaves the current access token
   * working for up to 15 minutes. That is the trade accepted in ADR-0010.
   */
  signAccessToken(claims: AccessTokenClaims): string {
    return this.jwt.sign(claims, {
      secret: this.config.jwtAccessSecret,
      expiresIn: this.config.accessTokenTtlSeconds,
    });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.jwt.verify<AccessTokenClaims>(token, {
      secret: this.config.jwtAccessSecret,
    });
  }

  /**
   * A refresh token is opaque and random — not a JWT.
   *
   * It carries no claims because it grants nothing on its own: it is a lookup key into a
   * row we control, which is exactly what makes revocation and reuse detection possible.
   * A self-describing refresh token would be revocable only by keeping a denylist, which
   * is the same database read with extra steps.
   */
  generateRefreshToken(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + this.config.refreshTokenTtlDays * 86_400_000),
    };
  }

  /** Same shape as a refresh token; used for email verification and password reset links. */
  generateVerificationToken(ttlMs: number): {
    token: string;
    tokenHash: string;
    expiresAt: Date;
  } {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) };
  }

  hash(token: string): string {
    return hashToken(token);
  }
}

/**
 * SHA-256, deliberately, and this is worth being able to defend.
 *
 * Passwords get argon2id because they are low-entropy and an attacker who steals the
 * hashes will guess them; a slow hash makes that expensive. A 256-bit random token has
 * nothing to guess — there is no dictionary of them — so the only thing a slow hash buys
 * is latency on every single refresh. Using argon2 here would look more careful and be
 * strictly worse.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
