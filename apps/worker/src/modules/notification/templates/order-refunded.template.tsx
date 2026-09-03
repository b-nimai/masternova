import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { OrderRefundedPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate } from './email-template';
import { TemplateKey } from './template-keys';
import { Heading, Paragraph } from './layout';

/**
 * Confirmation that money has been returned, and that access has ended with it.
 *
 * Mandatory for the same reason the receipt is: it is a record of a financial transaction,
 * and it tells the learner their access has stopped. Someone discovering that by clicking a
 * lecture and being refused is a support ticket the email prevents.
 */
@Injectable()
export class OrderRefundedTemplate extends EmailTemplate<OrderRefundedPayload> {
  readonly key = TemplateKey.OrderRefunded;
  readonly category: NotificationCategory = 'ACCOUNT_SECURITY';

  protected subjectFor(): string {
    return 'Your refund has been processed';
  }

  protected previewFor(payload: OrderRefundedPayload): string {
    return `${money(payload.amountMinor, payload.currency)} is on its way back to you.`;
  }

  protected body(payload: OrderRefundedPayload): ReactElement {
    return (
      <>
        <Heading>Your refund is on its way</Heading>
        <Paragraph>
          We have refunded <strong>{money(payload.amountMinor, payload.currency)}</strong> against
          order {payload.orderId}. Depending on your bank it usually appears within five to seven
          working days.
        </Paragraph>
        <Paragraph>
          Access to {payload.courseIds.length === 1 ? 'the course' : 'the courses'} on that order
          has ended. If you bought anything else, that is unaffected.
        </Paragraph>
        {payload.reason ? <Paragraph>Reason recorded: {payload.reason}</Paragraph> : null}
      </>
    );
  }
}

/** See the note in `order-receipt.template.tsx` — two decimal places is an assumption. */
function money(minor: number, currency: string): string {
  const symbol = currency === 'INR' ? '₹' : '$';
  return `${symbol}${(minor / 100).toFixed(2)}`;
}
