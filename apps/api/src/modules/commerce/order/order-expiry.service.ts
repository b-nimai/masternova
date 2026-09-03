import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OrderService } from './order.service';
import {
  ORDER_REPOSITORY,
  type IOrderRepository,
} from '../repositories/commerce.repository.interface';

/** Every five minutes. An order held for thirty does not need finer resolution than this. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Bounded, so one pass is a predictable amount of work whatever the backlog. */
const SWEEP_BATCH = 100;

/**
 * Releases orders nobody paid for.
 *
 * **What is actually being released is the coupon.** An abandoned order holds a
 * `CouponRedemption`, and a coupon capped at 100 uses would otherwise be exhausted by a
 * hundred people who opened the payment page and closed the tab. The order status itself
 * matters much less — nothing reads a stale `AWAITING_PAYMENT`.
 *
 * **Safe to run on every replica.** The transition underneath is a conditional UPDATE, so N
 * replicas sweeping the same batch produce one winner and N−1 no-ops — the losers get
 * `applied: false`. That is the same property the upload reaper relies on, and it is why
 * this needs no lock.
 *
 * It lives in the API for now, like the upload reaper before it, and moves to the worker's
 * scheduler with it.
 */
@Injectable()
export class OrderExpiryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderExpiryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    private readonly ordering: OrderService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns how many it expired — what the integration test asserts. */
  async sweep(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const stale = await this.orders.findExpirable(now, SWEEP_BATCH);
      let expired = 0;

      for (const order of stale) {
        try {
          // Through `OrderService`, not around it. The transition, the coupon release and
          // the event are one atomic unit that every un-paid ending shares, and a sweeper
          // that rebuilt them here would be the second producer of `order.expired` — which
          // is exactly how the two copies drifted into incompatible payloads once already.
          const { applied } = await this.ordering.apply(order.id, 'expire', {
            reason: 'not paid within the window',
          });

          if (applied) expired += 1;
        } catch (error) {
          // One bad order must not stop the sweep — the next may be the one holding the
          // last use of a launch coupon.
          this.logger.error(
            `failed to expire order ${order.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      if (expired > 0) this.logger.log(`expired ${expired} unpaid order(s)`);
      return expired;
    } finally {
      this.running = false;
    }
  }
}
