import {
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@masternova/db';
import { registerSchema, type PublicUser, type RegisterInput } from '@masternova/shared';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { AuthenticatedGuard } from '../../common/guards/authenticated.guard';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';

/** Requests carrying the passport-attached user after a strategy guard runs. */
type AuthedRequest = FastifyRequest & { user?: User };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  private startSession(req: FastifyRequest, userId: string): void {
    req.session.set('userId', userId);
  }

  @Post('register')
  async register(
    @ZodBody(registerSchema) dto: RegisterInput,
    @Req() req: FastifyRequest,
  ): Promise<PublicUser> {
    const user = await this.auth.register(dto);
    this.startSession(req, user.id);
    return this.auth.toPublic(user);
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(LocalAuthGuard)
  login(@Req() req: AuthedRequest): PublicUser {
    // LocalAuthGuard validated credentials and set req.user.
    const user = req.user as User;
    this.startSession(req, user.id);
    return this.auth.toPublic(user);
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Req() req: FastifyRequest): void {
    req.session.delete();
  }

  @Get('me')
  @UseGuards(AuthenticatedGuard)
  async me(@CurrentUserId() userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Session user not found');
    }
    return this.auth.toPublic(user);
  }

  // ----------------------------- Google OAuth -----------------------------
  // Active only when GOOGLE_CLIENT_ID/SECRET are set (strategy is conditionally
  // provided in auth.module.ts). Same-origin via the web proxy keeps cookies first-party.

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  google(): void {
    // GoogleAuthGuard redirects to Google's consent screen.
  }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  googleCallback(@Req() req: AuthedRequest, @Res() reply: FastifyReply): void {
    const user = req.user as User;
    this.startSession(req, user.id);
    void reply.redirect('/dashboard');
  }
}
