import { createHmac } from 'node:crypto';
import { WebhookSignatureException } from '../../../common/exceptions';
import { PaymentEventType } from './payment-provider.interface';
import { RazorpayAdapter } from './razorpay.adapter';

const SECRET = 'a-razorpay-webhook-secret-32-chars!!';

const adapter = (over: Partial<{ webhookSecret?: string }> = {}) =>
  new RazorpayAdapter({
    razorpayKeyId: 'rzp_test_key',
    razorpayKeySecret: 'secret',
    razorpayWebhookSecret: 'webhookSecret' in over ? over.webhookSecret : SECRET,
    providerTimeoutMs: 5_000,
    orderExpiryMinutes: 30,
    configured: true,
  } as never);

/** A body plus the signature Razorpay would have sent for it. */
const signed = (body: unknown, secret = SECRET) => {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    raw,
    headers: {
      'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
    },
  };
};

const captured = {
  id: 'evt_abc123',
  event: 'payment.captured',
  payload: {
    payment: {
      entity: {
        id: 'pay_xyz',
        order_id: 'order_rzp_1',
        amount: 249900,
        currency: 'INR',
        method: 'upi',
      },
    },
  },
};

describe('RazorpayAdapter', () => {
  describe('webhook verification', () => {
    it('accepts a body signed with the configured secret', () => {
      const { raw, headers } = signed(captured);
      const event = adapter().verifyWebhook(raw, headers);

      expect(event.type).toBe(PaymentEventType.PaymentCaptured);
      expect(event.providerEventId).toBe('evt_abc123');
      expect(event.providerOrderId).toBe('order_rzp_1');
      expect(event.providerPaymentId).toBe('pay_xyz');
      expect(event.amountMinor).toBe(249900);
      expect(event.method).toBe('upi');
    });

    /**
     * The signature is over the exact bytes. This is the test that fails if anyone ever
     * "helpfully" changes the controller to hand over a parsed object.
     */
    it('rejects a body whose bytes changed after signing', () => {
      const { raw, headers } = signed(captured);
      const tampered = Buffer.from(raw.toString('utf8').replace('249900', '100'));

      expect(() => adapter().verifyWebhook(tampered, headers)).toThrow(WebhookSignatureException);
    });

    it('rejects a signature made with another secret', () => {
      const { raw, headers } = signed(captured, 'a-completely-different-secret-3232');
      expect(() => adapter().verifyWebhook(raw, headers)).toThrow(WebhookSignatureException);
    });

    it('rejects a request with no signature header at all', () => {
      const { raw } = signed(captured);
      expect(() => adapter().verifyWebhook(raw, {})).toThrow(WebhookSignatureException);
    });

    /** Unverified is not the same as unconfigured, and this endpoint is public. */
    it('refuses everything when no webhook secret is configured', () => {
      const { raw, headers } = signed(captured);
      expect(() => adapter({ webhookSecret: undefined }).verifyWebhook(raw, headers)).toThrow(
        WebhookSignatureException,
      );
    });
  });

  describe('normalising their vocabulary into ours', () => {
    it('maps a failure, keeping the provider’s own code', () => {
      const body = {
        id: 'evt_fail',
        event: 'payment.failed',
        payload: {
          payment: {
            entity: { id: 'pay_1', order_id: 'order_1', amount: 100, error_code: 'BAD_REQUEST' },
          },
        },
      };
      const { raw, headers } = signed(body);
      const event = adapter().verifyWebhook(raw, headers);

      expect(event.type).toBe(PaymentEventType.PaymentFailed);
      expect(event.failureCode).toBe('BAD_REQUEST');
    });

    it('maps a refund', () => {
      const body = {
        id: 'evt_refund',
        event: 'refund.processed',
        payload: {
          refund: { entity: { id: 'rfnd_1', amount: 249900 } },
          payment: { entity: { id: 'pay_xyz', order_id: 'order_rzp_1' } },
        },
      };
      const { raw, headers } = signed(body);
      const event = adapter().verifyWebhook(raw, headers);

      expect(event.type).toBe(PaymentEventType.RefundProcessed);
      expect(event.providerRefundId).toBe('rfnd_1');
      expect(event.providerPaymentId).toBe('pay_xyz');
      expect(event.amountMinor).toBe(249900);
    });

    /**
     * Razorpay emits around forty event types and adds more without asking. Throwing on an
     * unknown one would turn a new provider feature into an endpoint returning 500 and a
     * provider retrying it for days.
     */
    it('ignores an event type it does not act on, rather than throwing', () => {
      const { raw, headers } = signed({ id: 'evt_x', event: 'subscription.charged', payload: {} });
      expect(adapter().verifyWebhook(raw, headers).type).toBe(PaymentEventType.Ignored);
    });

    it('survives a payload missing everything it hoped for', () => {
      const { raw, headers } = signed({ event: 'payment.captured' });
      const event = adapter().verifyWebhook(raw, headers);

      expect(event.type).toBe(PaymentEventType.PaymentCaptured);
      expect(event.providerPaymentId).toBeUndefined();
      // Still has a dedupe key, which is what the unique constraint needs.
      expect(event.providerEventId).toBe('payment.captured:unknown');
    });

    /** The dedupe key must be identical on every redelivery of the same event. */
    it('derives a stable id when the body carries none', () => {
      const body = {
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_stable', order_id: 'o1' } } },
      };
      const first = adapter().verifyWebhook(signed(body).raw, signed(body).headers);
      const second = adapter().verifyWebhook(signed(body).raw, signed(body).headers);

      expect(first.providerEventId).toBe(second.providerEventId);
      expect(first.providerEventId).toBe('payment.captured:pay_stable');
    });
  });
});
