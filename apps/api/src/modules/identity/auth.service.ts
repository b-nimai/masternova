import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { ConfigType } from '@nestjs/config';
import type { User } from '@masternova/db';
import { IdentityEvent, UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import type { PublicUser } from '@masternova/shared';
import { identityConfig } from '../../config/configuration';
import {
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
} from '../../common/exceptions';
import { USER_REPOSITORY, type IUserRepository } from './repositories/user.repository.interface';
import { SessionService, type DeviceInfo, type IssuedCredentials } from './session.service';
import { VerificationService } from './verification.service';

/**
 * Credential handling: register, verify a password, run the reset flow.
 *
 * It does not mint tokens ({@link TokenService}), does not own device lifecycle
 * ({@link SessionService}), and does not send email — it raises events and `notification`
 * reacts.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly sessions: SessionService,
    private readonly verification: VerificationService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(identityConfig.KEY) private readonly config: ConfigType<typeof identityConfig>,
  ) {}

  /** Explicit argon2id parameters — see the note in `identityConfig`. */
  private hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id, ...this.config.argon2 });
  }

  /**
   * Creates the account, issues a verification token, and publishes both events in the
   * same transaction as the insert. If the outbox write fails, the user is not created —
   * there is no state in which an account exists with no welcome email owed.
   */
  async register(input: { email: string; password: string; name?: string }): Promise<User> {
    if (await this.users.findByEmail(input.email)) {
      throw new EmailAlreadyRegisteredException();
    }
    const passwordHash = await this.hashPassword(input.password);

    return this.uow.execute(async (ctx) => {
      const user = await this.users.create(
        { email: input.email, passwordHash, name: input.name },
        ctx.executor,
      );

      ctx.publish({
        type: IdentityEvent.UserRegistered,
        aggregateType: 'User',
        aggregateId: user.id,
        payload: { email: user.email, name: user.name },
      });

      await this.verification.issue(
        ctx,
        user.id,
        'EMAIL_VERIFICATION',
        IdentityEvent.EmailVerificationRequested,
        { email: user.email, name: user.name },
      );

      return user;
    });
  }

  /**
   * Verifies a password.
   *
   * An account with no password is OAuth-only. It still runs a hash comparison against a
   * dummy so that the response time does not reveal which accounts exist — the timing
   * difference between "no such user" and "wrong password" is otherwise measurable.
   */
  async validateCredentials(email: string, password: string): Promise<User> {
    const user = await this.users.findByEmail(email);

    if (!user?.passwordHash) {
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      throw new InvalidCredentialsException();
    }
    if (!(await argon2.verify(user.passwordHash, password))) {
      throw new InvalidCredentialsException();
    }
    return user;
  }

  async login(
    input: { email: string; password: string },
    device: DeviceInfo,
  ): Promise<{ user: User; credentials: IssuedCredentials }> {
    const user = await this.validateCredentials(input.email, input.password);
    const credentials = await this.sessions.create(user, device);
    return { user, credentials };
  }

  /** Google OAuth callback: reuse an existing account by email, else create a verified one. */
  async findOrCreateOAuth(input: { email: string; name?: string }): Promise<User> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) return existing;

    return this.uow.execute(async (ctx) => {
      const user = await this.users.create({ email: input.email, name: input.name }, ctx.executor);
      // The provider already proved the address, so no verification token is issued.
      await this.users.markEmailVerified(user.id, ctx.executor);
      ctx.publish({
        type: IdentityEvent.UserRegistered,
        aggregateType: 'User',
        aggregateId: user.id,
        payload: { email: user.email, name: user.name, verified: true },
      });
      return user;
    });
  }

  async verifyEmail(token: string): Promise<void> {
    await this.uow.execute(async (ctx) => {
      const userId = await this.verification.redeem(token, 'EMAIL_VERIFICATION', ctx.executor);
      await this.users.markEmailVerified(userId, ctx.executor);
      const user = await this.users.findById(userId);
      ctx.publish({
        type: IdentityEvent.EmailVerified,
        aggregateType: 'User',
        aggregateId: userId,
        // The address travels on the event so the welcome email needs no lookup back
        // into identity. A consumer that queries the producer is not decoupled from it.
        payload: { email: user?.email, name: user?.name },
      });
    });
  }

  /**
   * Starts a password reset.
   *
   * Always reports success, even for an address with no account. Returning 404 here would
   * turn the reset form into the account-enumeration oracle the login form deliberately
   * is not.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return;

    await this.uow.execute(async (ctx) => {
      await this.verification.issue(
        ctx,
        user.id,
        'PASSWORD_RESET',
        IdentityEvent.PasswordResetRequested,
        { email: user.email, name: user.name },
      );
    });
  }

  /**
   * Completes a reset.
   *
   * Revoking every session is the point, not a nicety: someone resets their password
   * *because* they think a session is compromised, and leaving the attacker's refresh
   * chain alive would make the reset theatre.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const passwordHash = await this.hashPassword(newPassword);

    const userId = await this.uow.execute(async (ctx) => {
      const id = await this.verification.redeem(token, 'PASSWORD_RESET', ctx.executor);
      await this.users.updatePasswordHash(id, passwordHash, ctx.executor);
      const user = await this.users.findById(id);
      ctx.publish({
        type: IdentityEvent.PasswordChanged,
        aggregateType: 'User',
        aggregateId: id,
        payload: { email: user?.email, name: user?.name, via: 'reset' },
      });
      return id;
    });

    await this.sessions.revokeAllForUser(userId, 'PASSWORD_CHANGED');
  }

  toPublic(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

/**
 * A real argon2id hash of a value nobody knows, used only to burn the same CPU time as a
 * genuine verification when the account does not exist.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV4Y29ycmVjdGhvcnNl';
