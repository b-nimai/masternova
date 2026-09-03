import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../../common/decorators/public.decorator';
import { WebhookSignatureException } from '../../../common/exceptions';
import { PaymentWebhookService, type WebhookOutcome } from './webhook.service';

/**
 * The payment provider's callback.
 *
 * `@Public()` because the caller is Razorpay, which has no session — **the signature is the
 * authentication**, and it is checked over the raw bytes before anything is parsed.
 *
 * **Always 200 once the signature verifies**, whatever the outcome. A duplicate, an event
 * type we ignore, or an event for an order from another environment are all "we have this,
 * stop retrying" — and returning a 4xx or 5xx for any of them makes the provider redeliver
 * for days. The only non-2xx here is a bad signature, which is a 400 precisely because it
 * will never succeed on retry either.
 */
@Public()
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<{ outcome: WebhookOutcome }> {
    // Absent means the body parser consumed it, which would mean verifying a re-serialised
    // object — a check that fails open on key order and unicode escaping. Refuse instead.
    if (!request.rawBody) throw new WebhookSignatureException('raw body unavailable');

    return { outcome: await this.webhooks.receive(request.rawBody, headers) };
  }
}
