import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { SessionsController } from './sessions.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { SessionService } from './session.service';
import { VerificationService } from './verification.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { USER_REPOSITORY } from './repositories/user.repository.interface';
import { PrismaUserRepository } from './repositories/user.repository';

/**
 * The `identity` bounded context: who someone is, what device they are on, and what kind
 * of user they are.
 *
 * It does not decide what they may do with a *specific* course — that depends on purchases
 * and refund windows and belongs to the entitlement engine (task 1.8).
 *
 * Exports the guards and TokenService so the global guard registration in AppModule can
 * resolve them; nothing else of this module is visible outside it.
 */
@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController, SessionsController],
  providers: [
    AuthService,
    TokenService,
    SessionService,
    VerificationService,
    JwtAuthGuard,
    RolesGuard,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
  ],
  exports: [TokenService, JwtAuthGuard, RolesGuard],
})
export class IdentityModule {}
