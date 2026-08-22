import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from '@masternova/shared';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { appConfig } from '../../config/configuration';
import { AuthService } from './auth.service';
import { SessionService, type IssuedCredentials } from './session.service';
import { USER_REPOSITORY, type IUserRepository } from './repositories/user.repository.interface';
import { UnauthorizedException } from '@nestjs/common';

const ACCESS_COOKIE = 'masternova_access';
const REFRESH_COOKIE = 'masternova_refresh';
/** Scoped so the long-lived credential is only ever sent to the one route that spends it. */
const REFRESH_PATH = '/api/auth/refresh';

/** Thin by design: parse, delegate, map the response (CLAUDE.md §4). */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
  ) {}

  @Public()
  @Post('register')
  async register(@ZodBody(registerSchema) body: RegisterInput): Promise<PublicUser> {
    return this.auth.toPublic(await this.auth.register(body));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @ZodBody(loginSchema) body: LoginInput,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PublicUser> {
    const { user, credentials } = await this.auth.login(body, device(req));
    this.setAuthCookies(reply, credentials);
    return this.auth.toPublic(user);
  }

  /**
   * Exchanges the refresh cookie for a new pair.
   *
   * Public because an expired access token is the normal reason to be here — requiring a
   * valid one would make refresh useless.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) throw new UnauthorizedException('No refresh token');

    try {
      this.setAuthCookies(reply, await this.sessions.rotate(presented, device(req)));
      return { ok: true };
    } catch (error) {
      // Clear the cookies on any failure, including reuse detection. Leaving a spent
      // token in the browser guarantees the next request repeats the same failure.
      this.clearAuthCookies(reply);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (req.sessionId) await this.sessions.revokeSession(req.sessionId, 'LOGOUT');
    this.clearAuthCookies(reply);
  }

  /** "Sign out everywhere" — the thing you reach for when you think you have been phished. */
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (req.userId) await this.sessions.revokeAllForUser(req.userId, 'LOGOUT_ALL');
    this.clearAuthCookies(reply);
  }

  @Get('me')
  async me(@Req() req: FastifyRequest): Promise<PublicUser> {
    const user = await this.users.findById(req.userId as string);
    if (!user) throw new UnauthorizedException('Not authenticated');
    return this.auth.toPublic(user);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@ZodBody(verifyEmailSchema) body: VerifyEmailInput): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  /** Always 202, even for an unknown address — see AuthService.requestPasswordReset. */
  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @ZodBody(requestPasswordResetSchema) body: RequestPasswordResetInput,
  ): Promise<{ ok: true }> {
    await this.auth.requestPasswordReset(body.email);
    return { ok: true };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@ZodBody(resetPasswordSchema) body: ResetPasswordInput): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
  }

  private setAuthCookies(reply: FastifyReply, credentials: IssuedCredentials): void {
    const secure = this.app.nodeEnv === 'production';
    reply.setCookie(ACCESS_COOKIE, credentials.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
    });
    reply.setCookie(REFRESH_COOKIE, credentials.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      // Never sent to any other route, so an XSS-free but log-leaking endpoint elsewhere
      // cannot capture the long-lived credential.
      path: REFRESH_PATH,
    });
  }

  private clearAuthCookies(reply: FastifyReply): void {
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  }
}

function device(req: FastifyRequest) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}
