import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import {
  appConfig,
  googleConfig,
  identityConfig,
  notificationConfig,
  redisConfig,
  s3Config,
} from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { IdentityModule } from './modules/identity/identity.module';
import { JwtAuthGuard } from './modules/identity/guards/jwt-auth.guard';
import { RolesGuard } from './modules/identity/guards/roles.guard';
import { NotificationModule } from './modules/notification/notification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [appConfig, s3Config, redisConfig, googleConfig, identityConfig, notificationConfig],
    }),
    PrismaModule,
    HealthModule,
    OutboxModule,
    IdentityModule,
    NotificationModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: BigIntSerializerInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // Authentication is global and opt-OUT via @Public(). Forgetting the decorator then
    // fails closed — a 401 on a route that should be open — rather than leaving a route
    // unauthenticated with nobody noticing.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
