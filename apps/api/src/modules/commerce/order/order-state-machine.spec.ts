import type { OrderStatus } from '@masternova/db';
import {
  EXPIRABLE_STATUSES,
  isTerminal,
  transitionFor,
  transitionsFrom,
} from './order-state-machine';

const ALL: OrderStatus[] = [
  'CREATED',
  'AWAITING_PAYMENT',
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
];

describe('the order state machine', () => {
  /** Every status is reachable in the table, so a new enum value cannot be forgotten. */
  it('describes every status', () => {
    for (const status of ALL) expect(transitionsFrom(status)).toBeDefined();
  });

  describe('the forward-only invariant', () => {
    /**
     * The one that matters. A captured payment is a fact in the provider's ledger; "un-paying"
     * an order is a refund, with different accounting and a different effect on access.
     */
    it('never walks back out of PAID except by refunding', () => {
      expect(transitionsFrom('PAID').map((t) => t.to)).toEqual(['REFUNDED']);
    });

    it('has no way back into a pre-payment state from anywhere', () => {
      const backwards: OrderStatus[] = ['CREATED', 'AWAITING_PAYMENT'];
      for (const status of ALL) {
        if (backwards.includes(status)) continue;
        const destinations = transitionsFrom(status).map((t) => t.to);
        expect(destinations.filter((d) => backwards.includes(d))).toEqual([]);
      }
    });

    it('leaves every failure state terminal', () => {
      for (const status of ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] as OrderStatus[]) {
        expect(isTerminal(status)).toBe(true);
      }
      expect(isTerminal('PAID')).toBe(false);
    });
  });

  describe('what a webhook is allowed to do', () => {
    /**
     * A webhook is an unauthenticated caller. It may report what the provider did — captured,
     * failed, refunded — and nothing else. It must never cancel an order or push one to the
     * payment page on the learner's behalf.
     */
    it('lets a webhook capture, fail and refund, and nothing more', () => {
      const webhookEdges = ALL.flatMap((status) =>
        transitionsFrom(status)
          .filter((t) => t.fromWebhook)
          .map((t) => t.name),
      );
      expect([...new Set(webhookEdges)].sort()).toEqual(['capture', 'fail', 'refund']);
    });

    it('refuses a webhook the transitions reserved for the service', () => {
      expect(transitionFor('CREATED', 'submit', 'webhook')).toBeUndefined();
      expect(transitionFor('CREATED', 'cancel', 'webhook')).toBeUndefined();
      expect(transitionFor('CREATED', 'settleFree', 'webhook')).toBeUndefined();
      // But the service may.
      expect(transitionFor('CREATED', 'submit', 'service')).toBeDefined();
    });
  });

  describe('capture', () => {
    it('is legal from AWAITING_PAYMENT', () => {
      expect(transitionFor('AWAITING_PAYMENT', 'capture', 'webhook')?.to).toBe('PAID');
    });

    /**
     * Providers retry aggressively, so a second `payment.captured` for an already-PAID order
     * is routine. The machine simply has no such edge, and `undefined` is the no-op answer —
     * which is why this returns rather than throws.
     */
    it('is absent from PAID, so a redelivered capture is a no-op and not an error', () => {
      expect(transitionFor('PAID', 'capture', 'webhook')).toBeUndefined();
    });

    it('is absent from every terminal failure state', () => {
      for (const status of ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'] as OrderStatus[]) {
        expect(transitionFor(status, 'capture', 'webhook')).toBeUndefined();
      }
    });
  });

  describe('the free-order shortcut', () => {
    /** Without it the platform could not give a course away: no provider, no capture. */
    it('goes straight from CREATED to PAID, and only from there', () => {
      expect(transitionFor('CREATED', 'settleFree')?.to).toBe('PAID');
      expect(transitionFor('AWAITING_PAYMENT', 'settleFree')).toBeUndefined();
    });

    it('raises the same event a real capture does, so downstream sees one shape', () => {
      expect(transitionFor('CREATED', 'settleFree')?.event).toBe(
        transitionFor('AWAITING_PAYMENT', 'capture', 'webhook')?.event,
      );
    });
  });

  describe('events', () => {
    it('raises one only where something downstream acts on it', () => {
      const withEvents = ALL.flatMap((s) =>
        transitionsFrom(s)
          .filter((t) => t.event)
          .map((t) => `${s}:${t.name}`),
      );
      expect(withEvents.sort()).toEqual([
        'AWAITING_PAYMENT:capture',
        'AWAITING_PAYMENT:expire',
        'CREATED:expire',
        'CREATED:settleFree',
        'PAID:refund',
      ]);
    });

    it('says nothing when an order is cancelled, because nothing was granted', () => {
      expect(transitionFor('CREATED', 'cancel')?.event).toBeUndefined();
    });
  });

  it('can expire exactly the states that hold a reservation', () => {
    for (const status of ALL) {
      const expirable = transitionFor(status, 'expire') !== undefined;
      expect(expirable).toBe(EXPIRABLE_STATUSES.includes(status));
    }
  });

  it('reports an unknown transition rather than inventing one', () => {
    expect(transitionFor('CREATED', 'teleport')).toBeUndefined();
  });
});
