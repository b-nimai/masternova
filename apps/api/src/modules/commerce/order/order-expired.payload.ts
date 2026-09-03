import type { OrderExpiredPayload } from '@masternova/contracts';
import type { OrderWithItems } from '../repositories/commerce.repository.interface';

/**
 * The one place `commerce.order.expired` is shaped.
 *
 * **The force is that this event has two producers** — `OrderService.apply(id, 'expire')`
 * and the sweeper — and a consumer that reads `payload.items`. Two hand-built payload
 * literals is how one producer quietly emits a shape the handler destructures into a
 * `TypeError`, and the failure surfaces in the *worker*, three retries later, as a burnt
 * outbox message rather than as a test failure here.
 *
 * The lines are snapshotted for the same reason the receipt's are: the recovery email names
 * and prices the courses, and it renders long after the order was abandoned.
 */
export function orderExpiredPayload(order: OrderWithItems): OrderExpiredPayload {
  return {
    orderId: order.id,
    userId: order.userId,
    courseIds: order.items.map((item) => item.courseId),
    currency: order.currency,
    totalMinor: order.totalMinor,
    items: order.items.map((item) => ({
      courseId: item.courseId,
      title: item.titleSnapshot,
      unitPriceMinor: item.unitPriceMinor,
      discountMinor: item.discountMinor,
    })),
  };
}
