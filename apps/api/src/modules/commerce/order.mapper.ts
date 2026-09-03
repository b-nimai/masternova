import type { OrderView } from '@masternova/shared';
import type { OrderWithItems } from './repositories/commerce.repository.interface';

/**
 * The wire shape of an order.
 *
 * Deliberately omits `providerOrderId` and every provider identifier: those are between us
 * and the gateway, and putting them in a response the browser can read invites a client to
 * start reasoning about them.
 */
export function toOrderView(order: OrderWithItems): OrderView {
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    totalMinor: order.totalMinor,
    items: order.items.map((item) => ({
      courseId: item.courseId,
      title: item.titleSnapshot,
      unitPriceMinor: item.unitPriceMinor,
      discountMinor: item.discountMinor,
    })),
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
  };
}
