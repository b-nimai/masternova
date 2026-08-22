import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';
import type { ConfigType } from '@nestjs/config';
import { googleConfig } from '../../../config/configuration';
import { AuthService } from '../auth.service';

/**
 * Google OAuth 2.0 strategy. Only provided when GOOGLE_CLIENT_ID/SECRET are set
 * (see auth.module.ts) — the constructor would throw without a clientID, so the app
 * boots fine with Google sign-in disabled.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    @Inject(googleConfig.KEY) config: ConfigType<typeof googleConfig>,
    private readonly auth: AuthService,
  ) {
    super({
      clientID: config.clientId as string,
      clientSecret: config.clientSecret as string,
      callbackURL: config.callbackUrl,
      scope: ['email', 'profile'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error('Google account has no email address'));
      return;
    }
    const user = await this.auth.findOrCreateOAuth({ email, name: profile.displayName });
    done(null, user);
  }
}
