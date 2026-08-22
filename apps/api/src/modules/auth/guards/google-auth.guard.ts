import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Drives the Google OAuth redirect + callback. Active only when Google is configured. */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  getAuthenticateOptions(): { session: false } {
    return { session: false };
  }
}
