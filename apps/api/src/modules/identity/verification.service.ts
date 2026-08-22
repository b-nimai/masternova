import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { PrismaClient, VerificationPurpose } from '@masternova/db';
import type { TransactionContext } from '@masternova/contracts';
import { identityConfig } from '../../config/configuration';
import { TokenService } from './token.service';
import { InvalidVerificationTokenException } from '../../common/exceptions';

/**
 * Issues and redeems the single-use tokens that arrive by email — address verification and
 * password reset.
 *
 * It does not send anything. It raises an event carrying the token, and `notification`
 * (task 1.3) turns that into an email. That is what lets identity stay ignorant of SMTP,
 * and what stops a mail outage from failing a signup.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly tokens: TokenService,
    @Inject(identityConfig.KEY) private readonly config: ConfigType<typeof identityConfig>,
  ) {}

  /**
   * Issues a token inside the caller's transaction and publishes the event carrying it.
   *
   * Any previously-issued token for the same purpose is spent first: two live reset links
   * in an inbox means an old one still works after the user has used the new one, which is
   * a longer window than it needs to be.
   */
  async issue(
    ctx: TransactionContext,
    userId: string,
    purpose: VerificationPurpose,
    eventType: string,
    extraPayload: Record<string, unknown> = {},
  ): Promise<string> {
    const tx = ctx.executor as PrismaClient;
    const ttlMs =
      purpose === 'EMAIL_VERIFICATION'
        ? this.config.emailVerificationTtlHours * 3_600_000
        : this.config.passwordResetTtlMinutes * 60_000;

    const { token, tokenHash, expiresAt } = this.tokens.generateVerificationToken(ttlMs);

    await tx.verificationToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.verificationToken.create({ data: { userId, purpose, tokenHash, expiresAt } });

    ctx.publish({
      type: eventType,
      aggregateType: 'User',
      aggregateId: userId,
      // The raw token travels in the event because the email needs it. It is never stored.
      payload: { token, expiresAt: expiresAt.toISOString(), ...extraPayload },
    });

    return token;
  }

  /**
   * Redeems a token, or throws.
   *
   * Marking used inside the same transaction as the effect is what makes it single-use
   * under a double-click: two concurrent redemptions cannot both see `usedAt: null`.
   */
  async redeem(
    presented: string,
    purpose: VerificationPurpose,
    executor: unknown,
  ): Promise<string> {
    const tx = executor as PrismaClient;
    const tokenHash = this.tokens.hash(presented);

    const { count } = await tx.verificationToken.updateMany({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count === 0) {
      throw new InvalidVerificationTokenException();
    }

    const record = await tx.verificationToken.findUniqueOrThrow({ where: { tokenHash } });
    return record.userId;
  }
}
