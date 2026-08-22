import { Injectable } from '@nestjs/common';
import type { NotificationCategory, SuppressionReason } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IAudienceRepository } from './audience.repository.interface';

@Injectable()
export class PrismaAudienceRepository implements IAudienceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async suppressionFor(email: string): Promise<{ reason: SuppressionReason } | null> {
    const row = await this.prisma.emailSuppression.findUnique({
      where: { email },
      select: { reason: true },
    });
    return row ?? null;
  }

  async hasOptedOut(userId: string, category: NotificationCategory): Promise<boolean> {
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId_category: { userId, category } },
      select: { enabled: true },
    });
    return row?.enabled === false;
  }
}
