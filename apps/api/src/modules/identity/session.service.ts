import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Role, SessionRevokeReason } from '@masternova/db';
import { IdentityEvent, UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import type { PrismaClient } from '@masternova/db';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from './token.service';

export interface IssuedCredentials {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface DeviceInfo {
  userAgent?: string;
  ip?: string;
}

/**
 * Owns the lifecycle of a signed-in device: create a session, rotate its refresh token,
 * detect reuse, revoke.
 *
 * One sentence on what it does not do: it does not verify passwords and does not mint
 * tokens. Those are {@link AuthService} and {@link TokenService}.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  /** Starts a new session — one per sign-in, per device. */
  async create(user: { id: string; role: Role }, device: DeviceInfo): Promise<IssuedCredentials> {
    const refresh = this.tokens.generateRefreshToken();

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        userAgent: device.userAgent?.slice(0, 500),
        ip: device.ip,
        refreshTokens: {
          create: { tokenHash: refresh.tokenHash, expiresAt: refresh.expiresAt },
        },
      },
    });

    return {
      accessToken: this.tokens.signAccessToken({
        sub: user.id,
        role: user.role,
        sid: session.id,
      }),
      refreshToken: refresh.token,
      sessionId: session.id,
    };
  }

  /**
   * Exchanges a refresh token for a new pair, and rotates it.
   *
   * ⭐ The reuse case is the whole point of this method. Because every refresh mints a new
   * token and marks the old one used, a *used* token arriving again means the chain leaked
   * — the legitimate client would have moved on to the new one. We cannot tell whether the
   * attacker or the victim is holding the copy, so the only safe response is to revoke the
   * entire session and force a fresh sign-in.
   *
   * This is why used tokens are kept rather than deleted: you cannot detect the reuse of a
   * row you removed.
   */
  async rotate(presentedToken: string, device: DeviceInfo): Promise<IssuedCredentials> {
    const tokenHash = this.tokens.hash(presentedToken);

    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: true } } },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.usedAt) {
      await this.revokeOnReuse(existing.session.userId, existing.sessionId, {
        email: existing.session.user.email,
        name: existing.session.user.name,
        userAgent: existing.session.userAgent,
        ip: existing.session.ip,
      });
      this.logger.warn(
        `refresh token reuse detected on session ${existing.sessionId} — session revoked`,
      );
      throw new UnauthorizedException('Refresh token has already been used');
    }

    if (existing.session.revokedAt) {
      throw new UnauthorizedException('Session has been revoked');
    }

    if (existing.expiresAt <= new Date()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    const next = this.tokens.generateRefreshToken();

    // Marking used and minting the replacement must be atomic: a crash between them would
    // either strand the client with a spent token or leave two live tokens in one chain.
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.refreshToken.create({
        data: {
          sessionId: existing.sessionId,
          tokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
        },
      }),
      this.prisma.session.update({
        where: { id: existing.sessionId },
        data: {
          lastUsedAt: new Date(),
          userAgent: device.userAgent?.slice(0, 500) ?? existing.session.userAgent,
          ip: device.ip ?? existing.session.ip,
        },
      }),
    ]);

    return {
      accessToken: this.tokens.signAccessToken({
        sub: existing.session.userId,
        role: existing.session.user.role,
        sid: existing.sessionId,
      }),
      refreshToken: next.token,
      sessionId: existing.sessionId,
    };
  }

  /**
   * Revokes a session because its refresh chain was replayed, and tells the owner.
   *
   * The email is the half of this control that people forget. Silently killing the
   * session protects the account and leaves the human with no idea that a credential of
   * theirs is in someone else's hands — which is the one fact they could act on.
   *
   * Revocation and the event commit together, so there is no state in which a session was
   * killed for a security reason nobody will ever hear about.
   */
  private async revokeOnReuse(
    userId: string,
    sessionId: string,
    device: { email: string; name: string | null; userAgent: string | null; ip: string | null },
  ): Promise<void> {
    await this.uow.execute(async (ctx) => {
      const tx = ctx.executor as PrismaClient;
      await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' },
      });
      ctx.publish({
        type: IdentityEvent.RefreshReuseDetected,
        aggregateType: 'User',
        aggregateId: userId,
        payload: { sessionId, ...device },
      });
    });
  }

  async revokeSession(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Revokes every session for a user, and emits an event so the owner is told.
   *
   * Used on "sign out everywhere", on password change, and after reuse detection — in the
   * last two cases the user needs to know, which is why this publishes rather than just
   * writing rows.
   */
  async revokeAllForUser(userId: string, reason: SessionRevokeReason): Promise<number> {
    return this.uow.execute(async (ctx) => {
      const tx = ctx.executor as PrismaClient;
      const { count } = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });

      if (count > 0 && reason !== 'LOGOUT') {
        const user = await tx.user.findUnique({ where: { id: userId } });
        ctx.publish({
          type: IdentityEvent.SessionsRevoked,
          aggregateType: 'User',
          aggregateId: userId,
          payload: { reason, count, email: user?.email, name: user?.name },
        });
      }
      return count;
    });
  }

  /** For the "your devices" screen. Never returns token hashes. */
  listActive(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
  }

  /** Rejects a session id belonging to someone else — an IDOR guard, not a formality. */
  async revokeOwn(userId: string, sessionId: string): Promise<void> {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
    if (count === 0) {
      throw new UnauthorizedException('Session not found');
    }
  }
}
