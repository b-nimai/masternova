import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { databaseConfig, redisConfig } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Standalone DI context — no HTTP server. It owns the BullMQ consumers.
 *
 * Phase 0 boots the context with config, env validation and Prisma only. The queue
 * registration and the job processors arrive with the pipeline in task 1.7, scaffolded
 * via `nest g` so the module graph is wired by the CLI rather than by hand.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [redisConfig, databaseConfig],
    }),
    PrismaModule,
  ],
})
export class AppModule {}
