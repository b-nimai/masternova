import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { signUnsubscribeToken } from '@masternova/contracts';
import { OPTIONAL_NOTIFICATION_CATEGORIES } from '@masternova/shared';
import type { NotificationCategory } from '@masternova/db';
import { notificationConfig } from '../../config/configuration';
import {
  MAIL_PROVIDER,
  type MailProvider,
  type OutboundMail,
} from './mail/mail-provider.interface';
import { TemplateRegistry } from './templates/template.registry';
import type { RenderContext } from './templates/email-template';
import {
  EMAIL_DELIVERY_REPOSITORY,
  type DeliveryDescriptor,
  type IEmailDeliveryRepository,
} from './repositories/email-delivery.repository.interface';
import {
  AUDIENCE_REPOSITORY,
  type IAudienceRepository,
} from './repositories/audience.repository.interface';

export interface SendRequest {
  /** The outbox event that caused this. Half of the idempotency key. */
  readonly eventId: string;
  readonly templateKey: string;
  readonly to: string;
  readonly userId?: string;
  readonly payload: unknown;
}

/**
 * The one path an email takes: decide whether we may send, render it, claim it, send it,
 * record what happened.
 *
 * **It does not retry.** That is deliberate and it is the design decision worth defending:
 * this runs as an outbox handler, and the outbox already has exponential backoff, an
 * attempt cap and a dead-letter state (task 1.1). A retry loop here would be a second,
 * worse copy of that machinery sitting inside the first one — and the two would disagree
 * about how many attempts had happened. So a failed send throws, and the relay decides
 * when to try again.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly templates: TemplateRegistry,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(EMAIL_DELIVERY_REPOSITORY) private readonly deliveries: IEmailDeliveryRepository,
    @Inject(AUDIENCE_REPOSITORY) private readonly audience: IAudienceRepository,
    @Inject(notificationConfig.KEY)
    private readonly config: ConfigType<typeof notificationConfig>,
  ) {}

  async send(request: SendRequest): Promise<void> {
    const template = this.templates.get(request.templateKey);
    const recipient = request.to.trim().toLowerCase();

    const descriptor = (subject: string): DeliveryDescriptor => ({
      eventId: request.eventId,
      template: template.key,
      recipient,
      userId: request.userId,
      category: template.category,
      subject,
    });

    const refusal = await this.mayNotSend(recipient, request.userId, template.category);
    if (refusal) {
      // Recorded, not silently dropped. "Why didn't this arrive?" is the most common
      // question asked of an email system and the delivery log has to answer it.
      await this.deliveries.recordSuppressed(descriptor(template.key), refusal);
      this.logger.log(`suppressed ${template.key} to ${recipient}: ${refusal}`);
      return;
    }

    const unsubscribeToken = this.unsubscribeTokenFor(request.userId, template.category);
    const unsubscribeUrl = unsubscribeToken
      ? `${this.config.webUrl}/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`
      : undefined;
    const context: RenderContext = { webUrl: this.config.webUrl, unsubscribeUrl };

    // Rendered before the claim so the subject can be stored on the row. A duplicate
    // therefore does one wasted render, which is microseconds of CPU and no I/O — cheaper
    // than a two-phase claim that has to go back and fill the subject in afterwards.
    const rendered = await template.render(request.payload, context);

    const claim = await this.deliveries.claim(descriptor(rendered.subject));
    if (!claim.claimed) {
      this.logger.debug(`skipping ${template.key} for ${request.eventId}: ${claim.reason}`);
      return;
    }

    const mail: OutboundMail = {
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: this.unsubscribeHeaders(unsubscribeToken),
    };

    try {
      const { providerMessageId } = await this.mail.send(mail);
      await this.deliveries.markSent(claim.id, providerMessageId);
      this.logger.log(`sent ${template.key} to ${recipient} (${providerMessageId})`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.deliveries.markFailed(claim.id, detail);
      // Rethrown so the outbox message stays unpublished and is retried with backoff.
      // Swallowing it would mark the event handled and lose the email permanently.
      throw error;
    }
  }

  /**
   * The consent rules, in priority order, and the order is the whole point.
   *
   * Suppression is checked first and applies to every category including the mandatory
   * ones: a hard bounce is a fact about the mailbox, not a preference, and "but this is a
   * receipt" does not make a non-existent address deliverable. Preferences are checked
   * second and only for optional categories — offering to switch off a password-reset
   * link would be dishonest, so the option does not exist.
   */
  private async mayNotSend(
    recipient: string,
    userId: string | undefined,
    category: NotificationCategory,
  ): Promise<string | null> {
    const suppression = await this.audience.suppressionFor(recipient);
    if (suppression) return `address suppressed (${suppression.reason})`;

    if (!userId || !isOptional(category)) return null;

    return (await this.audience.hasOptedOut(userId, category))
      ? `user opted out of ${category}`
      : null;
  }

  /**
   * Only optional categories get an unsubscribe link, and only when we know who the
   * recipient is. A link on a password reset would promise something we will not honour.
   */
  private unsubscribeTokenFor(
    userId: string | undefined,
    category: NotificationCategory,
  ): string | undefined {
    if (!userId || !isOptional(category)) return undefined;
    return signUnsubscribeToken(this.config.unsubscribeSecret, { userId, category });
  }

  /**
   * RFC 8058 one-click unsubscribe.
   *
   * The header URL points at the **API**, not the footer link's web page, because a mail
   * provider POSTs it unattended and must reach something that just does the work. It is
   * a POST for the same reason the endpoint is: mail clients and corporate link scanners
   * prefetch every `href` they see, so a GET that unsubscribes would unsubscribe people
   * who never clicked anything. Gmail also requires this header pair to keep bulk mail
   * out of spam, so it is deliverability as well as correctness.
   */
  private unsubscribeHeaders(token: string | undefined): Record<string, string> | undefined {
    if (!token) return undefined;
    const url = `${this.config.apiUrl}/api/notifications/unsubscribe/${encodeURIComponent(token)}`;
    return {
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
}

function isOptional(category: NotificationCategory): boolean {
  return (OPTIONAL_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
}
