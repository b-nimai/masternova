import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import {
  databaseConfig,
  mailConfig,
  notificationConfig,
  redisConfig,
  s3Config,
  mediaToolsConfig,
} from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxRelayModule } from './modules/outbox-relay/outbox-relay.module';
import { NotificationModule } from './modules/notification/notification.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';

/**
 * Standalone DI context — no HTTP server.
 *
 * It runs the outbox relay (task 1.1), the notification send pipeline (task 1.3) and,
 * from task 1.7, the BullMQ job processors.
 * Both belong here rather than in the API because they are long-running loops with a
 * different resource profile from a request, and because this is the deployable that
 * autoscales on queue depth.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [
        redisConfig,
        databaseConfig,
        mailConfig,
        notificationConfig,
        s3Config,
        mediaToolsConfig,
      ],
    }),
    PrismaModule,
    OutboxRelayModule,
    NotificationModule,
    PipelineModule,
  ],
})
export class AppModule {}
