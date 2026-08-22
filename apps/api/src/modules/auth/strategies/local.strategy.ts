import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import type { User } from '@prisma/client';
import { AuthService } from '../auth.service';

/**
 * Email/password strategy. `AuthGuard('local')` runs this before the login handler;
 * `validate()`'s return value is attached to `request.user`. We use the email field
 * instead of passport-local's default `username`.
 */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly auth: AuthService) {
    super({ usernameField: 'email', passwordField: 'password' });
  }

  async validate(email: string, password: string): Promise<User> {
    try {
      return await this.auth.validate({ email, password });
    } catch {
      throw new UnauthorizedException('Invalid email or password');
    }
  }
}
