import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { OrderPaidPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate, type RenderContext } from './email-template';
import { TemplateKey } from './template-keys';
import { Button, Heading, Paragraph } from './layout';

/**
 * The receipt for a completed order.
 *
 * **`ACCOUNT_SECURITY`, which is a mandatory category — so it carries no unsubscribe link
 * and cannot be opted out of.** That is not a trick to get around preferences: a receipt is
 * part of the transaction the learner asked for, and in most jurisdictions a record of a
 * payment is something they are entitled to receive. Categorising it as marketing would let
 * somebody opt out of proof that they were charged.
 */
@Injectable()
export class OrderReceiptTemplate extends EmailTemplate<OrderPaidPayload> {
  readonly key = TemplateKey.OrderReceipt;
  readonly category: NotificationCategory = 'ACCOUNT_SECURITY';

  protected subjectFor(payload: OrderPaidPayload): string {
    const count = payload.items.length;
    return count === 1
      ? `Your receipt for ${payload.items[0].title}`
      : `Your receipt for ${count} courses`;
  }

  protected previewFor(payload: OrderPaidPayload): string {
    return `${money(payload.totalMinor, payload.currency)} — you now have access.`;
  }

  protected body(payload: OrderPaidPayload, ctx: RenderContext): ReactElement {
    return (
      <>
        <Heading>Thank you — your order is complete</Heading>
        <Paragraph>
          You now have full access to {payload.items.length === 1 ? 'this course' : 'these courses'}
          , for as long as your account exists.
        </Paragraph>

        {payload.items.map((item) => (
          <Paragraph key={item.courseId}>
            <strong>{item.title}</strong>
            <br />
            {money(item.unitPriceMinor, payload.currency)}
            {item.discountMinor > 0
              ? ` — ${money(item.discountMinor, payload.currency)} discount`
              : ''}
          </Paragraph>
        ))}

        <Paragraph>
          Subtotal {money(payload.subtotalMinor, payload.currency)}
          {payload.discountMinor > 0
            ? ` · Discount −${money(payload.discountMinor, payload.currency)}`
            : ''}
          <br />
          <strong>Total paid {money(payload.totalMinor, payload.currency)}</strong>
        </Paragraph>

        <Paragraph>
          {/* The order id, because it is the first thing support will ask for. */}
          Order reference: {payload.orderId}
        </Paragraph>

        <Paragraph>
          <Button href={`${ctx.webUrl}/learn`}>Start learning</Button>
        </Paragraph>
      </>
    );
  }
}

/**
 * Minor units to a readable amount.
 *
 * Two decimal places, hard-coded, and that is a known limitation rather than an oversight:
 * JPY has none and KWD has three. `Currency` is INR and USD today, both of which are two,
 * and the day a third arrives this becomes a table. Said out loud because a silent
 * assumption about money is the kind that survives until it is expensive.
 */
function money(minor: number, currency: string): string {
  const symbol = currency === 'INR' ? '₹' : '$';
  return `${symbol}${(minor / 100).toFixed(2)}`;
}
