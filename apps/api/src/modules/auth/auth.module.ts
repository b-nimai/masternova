import { Module, type Provider } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import type { ConfigType } from '@nestjs/config';
import { googleConfig } from '../../config/configuration';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocalStrategy } from './strategies/local.strategy';
import { GoogleStrategy } from './strategies/google.strategy';

// Google sign-in is opt-in: the strategy is only instantiated when credentials are
// present (googleConfig.enabled), so the app boots without them. Gate reads validated
// config, not process.env.
const googleStrategyProvider: Provider = {
  provide: GoogleStrategy,
  useFactory: (config: ConfigType<typeof googleConfig>, auth: AuthService) =>
    config.enabled ? new GoogleStrategy(config, auth) : null,
  inject: [googleConfig.KEY, AuthService],
};

@Module({
  imports: [UsersModule, PassportModule],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, googleStrategyProvider],
})
export class AuthModule {}
