import { Injectable, Logger } from '@nestjs/common';
import type { EmailDeliveryStatus } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  ClaimOutcome,
  DeliveryDescriptor,
  IEmailDeliveryRepository,
} from './email-delivery.repository.interface';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * How long a `SENDING` row is trusted before it is treated as abandoned.
 *
 * It matches the outbox relay's visibility timeout on purpose: that is the longest a
 * healthy sender can hold a message, so anything older belongs to a process that died
 * mid-send. Without this the row would block the retry forever and the email would be
 * lost by a mechanism built to stop exactly that.
 */
const SENDING_STALE_AFTER_MS = 5 * 60_000;

@Injectable()
export class PrismaEmailDeliveryRepository implements IEmailDeliveryRepository {
  private readonly logger = new Logger(PrismaEmailDeliveryRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async claim(descriptor: DeliveryDescriptor): Promise<ClaimOutcome> {
    try {
      const created = await this.prisma.emailDelivery.create({
        data: {
          eventId: descriptor.eventId,
          template: descriptor.template,
          recipient: descriptor.recipient,
          userId: descriptor.userId,
          category: descriptor.category,
          subject: descriptor.subject,
          status: 'SENDING',
        },
      });
      return { claimed: true, id: created.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.emailDelivery.findUnique({
      where: {
        eventId_template_recipient: {
          eventId: descriptor.eventId,
          template: descriptor.template,
          recipient: descriptor.recipient,
        },
      },
    });

    // Swept between the failed insert and this read. Treat it as a fresh send.
    if (!existing) return { claimed: false, reason: 'row disappeared between insert and read' };

    if (existing.status === 'FAILED' || isStaleSend(existing.status, existing.updatedAt)) {
      await this.prisma.emailDelivery.update({
        where: { id: existing.id },
        data: { status: 'SENDING', attempts: { increment: 1 }, detail: null },
      });
      return { claimed: true, id: existing.id };
    }

    return { claimed: false, reason: `already ${existing.status.toLowerCase()}` };
  }

  async markSent(id: string, providerMessageId: string): Promise<void> {
    await this.prisma.emailDelivery.update({
      where: { id },
      data: { status: 'SENT', providerMessageId, sentAt: new Date(), detail: null },
    });
  }

  async markFailed(id: string, detail: string): Promise<void> {
    await this.prisma.emailDelivery.update({
      where: { id },
      data: { status: 'FAILED', detail: detail.slice(0, 1000) },
    });
  }

  async recordSuppressed(descriptor: DeliveryDescriptor, detail: string): Promise<void> {
    await this.prisma.emailDelivery.upsert({
      where: {
        eventId_template_recipient: {
          eventId: descriptor.eventId,
          template: descriptor.template,
          recipient: descriptor.recipient,
        },
      },
      create: {
        eventId: descriptor.eventId,
        template: descriptor.template,
        recipient: descriptor.recipient,
        userId: descriptor.userId,
        category: descriptor.category,
        subject: descriptor.subject,
        status: 'SUPPRESSED',
        detail,
      },
      // A retry of a suppressed send must not overwrite a row that has since been SENT,
      // so only the reason is refreshed and the status is left alone on conflict.
      update: { detail },
    });
  }

  async markByProviderMessageId(
    providerMessageId: string,
    status: EmailDeliveryStatus,
    detail: string,
  ): Promise<number> {
    const { count } = await this.prisma.emailDelivery.updateMany({
      where: { providerMessageId },
      data: { status, detail: detail.slice(0, 1000) },
    });
    if (count === 0) {
      this.logger.warn(`no delivery row for provider message ${providerMessageId}`);
    }
    return count;
  }
}

function isStaleSend(status: EmailDeliveryStatus, updatedAt: Date): boolean {
  return status === 'SENDING' && Date.now() - updatedAt.getTime() > SENDING_STALE_AFTER_MS;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}
