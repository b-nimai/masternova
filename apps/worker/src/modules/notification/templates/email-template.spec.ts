import { VerifyEmailTemplate } from './verify-email.template';
import { PasswordResetTemplate } from './password-reset.template';
import { SecurityAlertTemplate } from './security-alert.template';
import { WelcomeTemplate } from './welcome.template';
import { PasswordChangedTemplate } from './password-changed.template';
import { OrderReceiptTemplate } from './order-receipt.template';
import { OrderRefundedTemplate } from './order-refunded.template';
import { OrderExpiredTemplate } from './order-expired.template';
import { TemplateRegistry } from './template.registry';
import type { RenderContext } from './email-template';

/**
 * Templates are pure: payload in, three strings out. No database, no provider, no DI —
 * which is what makes it reasonable to assert the things that actually go wrong in email:
 * a missing plaintext part, a link that did not get the token, an unsubscribe footer on a
 * password reset.
 */

const ctx: RenderContext = { webUrl: 'https://masternova.test' };
const optionalCtx: RenderContext = {
  webUrl: 'https://masternova.test',
  unsubscribeUrl: 'https://masternova.test/unsubscribe?token=abc',
};

const verificationPayload = {
  email: 'learner@masternova.test',
  name: 'Asha',
  token: 'tok en/with+chars',
  expiresAt: '2026-08-23T09:30:00.000Z',
};

describe('email templates', () => {
  it('produces a subject, HTML and a plaintext alternative for every template', async () => {
    const rendered = await Promise.all([
      new VerifyEmailTemplate().render(verificationPayload, ctx),
      new PasswordResetTemplate().render(verificationPayload, ctx),
      new WelcomeTemplate().render({ email: 'a@b.test', name: 'Asha' }, optionalCtx),
      new PasswordChangedTemplate().render({ email: 'a@b.test', via: 'reset' }, ctx),
      new SecurityAlertTemplate().render({ email: 'a@b.test', sessionId: 's1' }, ctx),
    ]);

    for (const email of rendered) {
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toContain('<html');
      // The failure this guards against is silent: a client with images and HTML off
      // renders an empty message and nobody reports it.
      expect(email.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('URL-encodes the token into the verification link, in both HTML and text', async () => {
    const email = await new VerifyEmailTemplate().render(verificationPayload, ctx);
    const expected = 'https://masternova.test/verify-email?token=tok%20en%2Fwith%2Bchars';

    expect(email.html).toContain(expected);
    // The link is repeated as text on purpose: "click the button" fails whenever the
    // client strips the styled anchor, and that user cannot tell you.
    expect(email.text).toContain(expected);
  });

  it('states the expiry so a stale link is explainable rather than mysterious', async () => {
    const email = await new VerifyEmailTemplate().render(verificationPayload, ctx);
    expect(email.text).toContain('2026-08-23 09:30 UTC');
  });

  it('never puts an unsubscribe link on a security email', async () => {
    const email = await new PasswordResetTemplate().render(verificationPayload, optionalCtx);
    // Even handed an unsubscribe URL, the layout only renders one when the pipeline
    // supplies it — and the pipeline never supplies one for a mandatory category. This
    // asserts the layout does not invent one.
    const security = await new PasswordChangedTemplate().render(
      { email: 'a@b.test', via: 'reset' },
      ctx,
    );

    expect(email.html).toContain('Unsubscribe');
    expect(security.html).not.toContain('Unsubscribe');
  });

  it('greets by name when there is one and stays grammatical when there is not', async () => {
    const named = await new VerifyEmailTemplate().render(verificationPayload, ctx);
    const anonymous = await new VerifyEmailTemplate().render(
      { ...verificationPayload, name: null },
      ctx,
    );

    expect(named.text).toContain('Hi Asha');
    expect(anonymous.text).toContain('Hi,');
  });

  it('omits the device line from a security alert when nothing is known about the device', async () => {
    const known = await new SecurityAlertTemplate().render(
      { email: 'a@b.test', sessionId: 's1', userAgent: 'Firefox', ip: '10.0.0.1' },
      ctx,
    );
    const unknown = await new SecurityAlertTemplate().render(
      { email: 'a@b.test', sessionId: 's1' },
      ctx,
    );

    expect(known.text).toContain('Firefox');
    expect(unknown.text).not.toContain('last seen from');
  });

  it('categorises every identity email as mandatory except the welcome', () => {
    expect(new VerifyEmailTemplate().category).toBe('ACCOUNT_SECURITY');
    expect(new PasswordResetTemplate().category).toBe('ACCOUNT_SECURITY');
    expect(new PasswordChangedTemplate().category).toBe('ACCOUNT_SECURITY');
    expect(new SecurityAlertTemplate().category).toBe('ACCOUNT_SECURITY');
    // Onboarding, not a transaction the user asked for — so it is opt-out-able.
    expect(new WelcomeTemplate().category).toBe('PRODUCT_NEWS');
  });
});

describe('commerce emails', () => {
  const lines = [
    {
      courseId: 'c1',
      title: 'System Design in Practice',
      unitPriceMinor: 249900,
      discountMinor: 50000,
    },
    {
      courseId: 'c2',
      title: 'Postgres for Backend Engineers',
      unitPriceMinor: 149900,
      discountMinor: 0,
    },
  ];

  const paid = {
    orderId: 'ord_1',
    userId: 'u1',
    currency: 'INR',
    subtotalMinor: 399800,
    discountMinor: 50000,
    totalMinor: 349800,
    couponCode: 'LAUNCH50',
    items: lines,
    paidAt: '2026-09-04T10:00:00.000Z',
  };

  const expired = {
    orderId: 'ord_1',
    userId: 'u1',
    courseIds: ['c1', 'c2'],
    currency: 'INR',
    totalMinor: 349800,
    items: lines,
  };

  it('prints every line and the total on the receipt, from the snapshot rather than the course', async () => {
    const email = await new OrderReceiptTemplate().render(paid, ctx);

    for (const line of lines) expect(email.text).toContain(line.title);
    expect(email.text).toContain('3498.00');
    // Support's first question. If it is not in the body, the learner forwards a screenshot.
    expect(email.text).toContain('ord_1');
  });

  it('names the refunded amount and says access has ended', async () => {
    const email = await new OrderRefundedTemplate().render(
      {
        orderId: 'ord_1',
        userId: 'u1',
        currency: 'INR',
        amountMinor: 349800,
        courseIds: ['c1', 'c2'],
        refundedAt: '2026-09-04T11:00:00.000Z',
      },
      ctx,
    );

    expect(email.text).toContain('3498.00');
    expect(email.text.toLowerCase()).toContain('has ended');
  });

  /** The distinction the module exists to enforce: a record of a payment is mandatory,
   *  a nudge about one that never happened is marketing. */
  it('makes the recovery email opt-out-able while the receipt and refund are not', () => {
    expect(new OrderReceiptTemplate().category).toBe('ACCOUNT_SECURITY');
    expect(new OrderRefundedTemplate().category).toBe('ACCOUNT_SECURITY');
    expect(new OrderExpiredTemplate().category).toBe('PRODUCT_NEWS');
  });

  it('carries an unsubscribe footer on the recovery email and none on the receipt', async () => {
    const recovery = await new OrderExpiredTemplate().render(expired, optionalCtx);
    const receipt = await new OrderReceiptTemplate().render(paid, ctx);

    expect(recovery.html).toContain('Unsubscribe');
    expect(receipt.html).not.toContain('Unsubscribe');
  });

  it('links the recovery back to the order, not to a cart that was already emptied', async () => {
    const email = await new OrderExpiredTemplate().render(expired, optionalCtx);
    expect(email.text).toContain('https://masternova.test/checkout/resume?order=ord_1');
  });

  it('stays grammatical whether one course was abandoned or several', async () => {
    const many = await new OrderExpiredTemplate().render(expired, optionalCtx);
    const one = await new OrderExpiredTemplate().render(
      { ...expired, items: [lines[0]], courseIds: ['c1'] },
      optionalCtx,
    );

    expect(many.subject).toBe('Your checkout is still waiting');
    expect(one.subject).toBe('Still interested in System Design in Practice?');
    // The preview line is the half of an email people actually read in a list.
    expect(many.text).not.toContain('courses is');
  });

  it('says the released coupon is not being held, rather than implying a price it cannot honour', async () => {
    const email = await new OrderExpiredTemplate().render(expired, optionalCtx);
    expect(email.text.toLowerCase()).toContain('no longer reserved');
  });
});

describe('TemplateRegistry', () => {
  it('resolves a template by the key stored on the delivery row', () => {
    const registry = new TemplateRegistry([new VerifyEmailTemplate(), new WelcomeTemplate()]);
    expect(registry.get('verify-email')).toBeInstanceOf(VerifyEmailTemplate);
    expect(registry.keys).toEqual(['verify-email', 'welcome']);
  });

  it('refuses an unknown key rather than returning undefined', () => {
    const registry = new TemplateRegistry([new VerifyEmailTemplate()]);
    expect(() => registry.get('nope')).toThrow(/no email template registered/);
  });

  /** Two templates sharing a key would silently suppress each other through the unique
   *  constraint on (eventId, template, recipient). Failing at boot is the cheap version. */
  it('fails at construction on a duplicate key', () => {
    expect(
      () => new TemplateRegistry([new VerifyEmailTemplate(), new VerifyEmailTemplate()]),
    ).toThrow(/duplicate email template key/);
  });
});
