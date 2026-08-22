import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { MailWebhookController } from './mail-webhook.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  SUPPRESSION_REPOSITORY,
} from './repositories/notification.repository.interface';
import {
  PrismaNotificationPreferenceRepository,
  PrismaSuppressionRepository,
} from './repositories/notification.repository';

/**
 * The `notification` bounded context, request side.
 *
 * The context is split across two deployables, exactly as the outbox is (task 1.1): what
 * happens inside a request lives here, what happens on a background loop lives in
 * `apps/worker`. This half owns consent — the preference centre, the unsubscribe link,
 * and the bounce webhook that suppresses an address. It sends nothing and renders nothing.
 */
@Module({
  controllers: [NotificationController, MailWebhookController],
  providers: [
    NotificationPreferencesService,
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      useClass: PrismaNotificationPreferenceRepository,
    },
    { provide: SUPPRESSION_REPOSITORY, useClass: PrismaSuppressionRepository },
  ],
  exports: [NotificationPreferencesService],
})
export class NotificationModule {}
