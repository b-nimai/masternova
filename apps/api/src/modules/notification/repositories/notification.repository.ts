import { Injectable } from '@nestjs/common';
import type {
  EmailDeliveryStatus,
  NotificationCategory,
  NotificationPreference,
  SuppressionReason,
} from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  INotificationPreferenceRepository,
  ISuppressionRepository,
} from './notification.repository.interface';

@Injectable()
export class PrismaNotificationPreferenceRepository implements INotificationPreferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  listFor(userId: string): Promise<NotificationPreference[]> {
    return this.prisma.notificationPreference.findMany({ where: { userId } });
  }

  /**
   * Upsert, not insert-or-update in two statements: a user double-clicking a toggle would
   * otherwise race itself and one of the two requests would fail on the primary key.
   */
  async set(userId: string, category: NotificationCategory, enabled: boolean): Promise<void> {
    await this.prisma.notificationPreference.upsert({
      where: { userId_category: { userId, category } },
      create: { userId, category, enabled },
      update: { enabled },
    });
  }
}

@Injectable()
export class PrismaSuppressionRepository implements ISuppressionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent by construction. Providers retry webhooks, and a second HARD_BOUNCE for the
   * same address must be a no-op rather than an error that makes the provider retry again.
   */
  async suppress(email: string, reason: SuppressionReason, detail?: string): Promise<void> {
    await this.prisma.emailSuppression.upsert({
      where: { email },
      create: { email, reason, detail },
      update: { reason, detail },
    });
  }

  async markDeliveryByProviderMessageId(
    providerMessageId: string,
    status: EmailDeliveryStatus,
    detail: string,
  ): Promise<{ recipient: string } | null> {
    const delivery = await this.prisma.emailDelivery.findFirst({
      where: { providerMessageId },
      select: { id: true, recipient: true },
    });
    if (!delivery) return null;

    await this.prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status, detail: detail.slice(0, 1000) },
    });
    return { recipient: delivery.recipient };
  }
}
