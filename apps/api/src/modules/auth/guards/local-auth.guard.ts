import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Runs the local (email/password) strategy. We persist the session ourselves via
 * @fastify/secure-session, so passport's own session handling is disabled.
 */
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {
  getAuthenticateOptions(): { session: false } {
    return { session: false };
  }
}
