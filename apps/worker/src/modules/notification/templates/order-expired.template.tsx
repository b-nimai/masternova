import { Injectable } from '@nestjs/common';
import type { ReactElement } from 'react';
import type { OrderExpiredPayload } from '@masternova/contracts';
import type { NotificationCategory } from '@masternova/db';
import { EmailTemplate, type RenderContext } from './email-template';
import { TemplateKey } from './template-keys';
import { Button, Fine, Heading, Paragraph } from './layout';

/**
 * The recovery email for an order nobody paid for.
 *
 * **`PRODUCT_NEWS`, an optional category, and that is the whole design decision here.** The
 * receipt and the refund notice are records of a transaction that happened, so they are
 * mandatory. This one is a nudge about a transaction that did *not* happen — an
 * abandoned-cart email, which is marketing however useful it is. Filing it under `PURCHASE`
 * to escape the preference check would be dressing marketing up as a receipt, and it is the
 * kind of shortcut that ends up in a spam complaint rather than a sale. Optional means the
 * shared layout also gives it an unsubscribe footer (§6.1).
 *
 * The prices are reprinted from the snapshot on the event, so the email is honest about
 * what was offered even if the course has been repriced since the tab was closed. The link
 * deliberately points at the *order*, not at the cart: the cart was emptied at checkout, and
 * the resume route rebuilds it from the expired order's lines.
 */
@Injectable()
export class OrderExpiredTemplate extends EmailTemplate<OrderExpiredPayload> {
  readonly key = TemplateKey.OrderExpired;
  readonly category: NotificationCategory = 'PRODUCT_NEWS';

  protected subjectFor(payload: OrderExpiredPayload): string {
    return payload.items.length === 1
      ? `Still interested in ${payload.items[0].title}?`
      : 'Your checkout is still waiting';
  }

  protected previewFor(payload: OrderExpiredPayload): string {
    const [first] = payload.items;
    const what =
      payload.items.length === 1 ? `${first.title} is` : `${payload.items.length} courses are`;
    return `${what} still one click away — nothing was charged.`;
  }

  protected body(payload: OrderExpiredPayload, ctx: RenderContext): ReactElement {
    return (
      <>
        <Heading>You left something behind</Heading>
        <Paragraph>
          We held {payload.items.length === 1 ? 'this course' : 'these courses'} for you while your
          payment went through, and it never completed. Nothing was charged.
        </Paragraph>

        {payload.items.map((item) => (
          <Paragraph key={item.courseId}>
            <strong>{item.title}</strong>
            <br />
            {money(item.unitPriceMinor, payload.currency)}
          </Paragraph>
        ))}

        <Paragraph>
          <Button
            href={`${ctx.webUrl}/checkout/resume?order=${encodeURIComponent(payload.orderId)}`}
          >
            Resume checkout
          </Button>
        </Paragraph>

        <Fine>
          {/* Said plainly, because a recovery email that implies a held price it cannot
              honour is worse than no email. Any coupon on the expired order was released
              back to its pool when the order expired. */}
          Prices shown are what you saw at checkout and may have changed since. A discount code
          applied to the original order is no longer reserved for you.
        </Fine>
      </>
    );
  }
}

/** See the note in `order-receipt.template.tsx` — two decimal places is an assumption. */
function money(minor: number, currency: string): string {
  const symbol = currency === 'INR' ? '₹' : '$';
  return `${symbol}${(minor / 100).toFixed(2)}`;
}
