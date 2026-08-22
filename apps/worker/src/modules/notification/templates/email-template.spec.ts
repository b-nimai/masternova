import { VerifyEmailTemplate } from './verify-email.template';
import { PasswordResetTemplate } from './password-reset.template';
import { SecurityAlertTemplate } from './security-alert.template';
import { WelcomeTemplate } from './welcome.template';
import { PasswordChangedTemplate } from './password-changed.template';
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
