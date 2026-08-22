import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, Headers, Inject, Logger, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ConfigType } from '@nestjs/config';
import { notificationConfig } from '../../config/configuration';
import { Public } from '../../common/decorators/public.decorator';
import { InvalidWebhookSignatureException } from '../../common/exceptions';
import {
  SUPPRESSION_REPOSITORY,
  type ISuppressionRepository,
} from './repositories/notification.repository.interface';

/** What Resend posts. Only the fields we act on are modelled. */
interface MailWebhookEvent {
  type?: string;
  data?: { email_id?: string; to?: string[] };
}

/**
 * Where the provider tells us a message did not arrive.
 *
 * This endpoint is the reason `EmailSuppression` exists. A hard bounce means the mailbox
 * does not exist, and continuing to send to it is what gets a sending domain blocklisted —
 * at which point *every* user stops receiving receipts, not just this one. So a bounce
 * suppresses the address globally, ahead of every preference and every mandatory category.
 *
 * A complaint ("this is spam") suppresses too, and is worse: complaint rate is the metric
 * mailbox providers actually throttle on.
 */
@Controller('webhooks/mail')
export class MailWebhookController {
  private readonly logger = new Logger(MailWebhookController.name);

  constructor(
    @Inject(SUPPRESSION_REPOSITORY) private readonly suppressions: ISuppressionRepository,
    @Inject(notificationConfig.KEY)
    private readonly config: ConfigType<typeof notificationConfig>,
  ) {}

  @Public()
  @Post('resend')
  async handle(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('webhook-signature') signature: string | undefined,
    @Headers('webhook-id') id: string | undefined,
    @Headers('webhook-timestamp') timestamp: string | undefined,
  ): Promise<{ received: true }> {
    // The signature covers the exact bytes the provider sent. Re-serialising the parsed
    // body would change key order and whitespace and never verify, so a missing raw body
    // is a rejection rather than a best-effort guess (`rawBody: true` in main.ts).
    const raw = request.rawBody?.toString('utf8');
    if (raw === undefined) throw new InvalidWebhookSignatureException();
    this.verify(`${id}.${timestamp}.${raw}`, signature);

    const event = request.body as MailWebhookEvent;
    const providerMessageId = event.data?.email_id;
    const recipient = event.data?.to?.[0];

    switch (event.type) {
      case 'email.bounced':
        await this.suppress(providerMessageId, recipient, 'BOUNCED', 'HARD_BOUNCE');
        break;
      case 'email.complained':
        await this.suppress(providerMessageId, recipient, 'COMPLAINED', 'COMPLAINT');
        break;
      default:
        // Deliveries and opens arrive here too. Not an error — the provider decides what
        // to send, and answering 2xx is what stops it retrying forever.
        this.logger.debug(`ignoring mail webhook of type ${event.type}`);
    }

    // Always 2xx once the signature verifies. A 500 on an event we do not model would
    // have the provider redeliver it every few minutes until it gives up on the endpoint
    // entirely, taking the bounces we DO care about with it.
    return { received: true };
  }

  /**
   * Updates the delivery row and suppresses the address.
   *
   * The recipient is taken from our own row where possible rather than from the webhook
   * body: the row is what we actually sent to, already normalised, and it is not
   * attacker-controlled. The body's address is the fallback for a message we cannot find.
   */
  private async suppress(
    providerMessageId: string | undefined,
    fallbackRecipient: string | undefined,
    deliveryStatus: 'BOUNCED' | 'COMPLAINED',
    reason: 'HARD_BOUNCE' | 'COMPLAINT',
  ): Promise<void> {
    const updated = providerMessageId
      ? await this.suppressions.markDeliveryByProviderMessageId(
          providerMessageId,
          deliveryStatus,
          reason,
        )
      : null;

    const email = updated?.recipient ?? fallbackRecipient;
    if (!email) {
      this.logger.warn(`${reason} webhook with no recipient and no matching delivery row`);
      return;
    }

    await this.suppressions.suppress(email.toLowerCase(), reason, `reported by provider`);
    this.logger.warn(`suppressed ${email} after ${reason}`);
  }

  /**
   * Svix-style HMAC over `id.timestamp.body`, base64, one or more space-separated
   * `v1,<sig>` values so the provider can rotate keys.
   *
   * Failing closed when no secret is configured is deliberate: an endpoint that skips
   * verification "because it is not set up yet" is an endpoint anyone can use to
   * blocklist any address in the system.
   */
  private verify(signedPayload: string, header: string | undefined): void {
    const secret = this.config.webhookSecret;
    if (!secret || !header) throw new InvalidWebhookSignatureException();

    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key).update(signedPayload).digest('base64');

    const presented = header.split(' ').map((part) => part.split(',')[1] ?? part);
    const ok = presented.some((candidate) => equals(expected, candidate));
    if (!ok) throw new InvalidWebhookSignatureException();
  }
}

/** Constant-time, so a wrong signature does not leak how much of it was right. */
function equals(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
