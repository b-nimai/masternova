import { NotificationService } from './notification.service';
import { TemplateRegistry } from './templates/template.registry';
import { EmailTemplate, type RenderContext } from './templates/email-template';
import type { MailProvider, OutboundMail } from './mail/mail-provider.interface';
import type {
  ClaimOutcome,
  DeliveryDescriptor,
  IEmailDeliveryRepository,
} from './repositories/email-delivery.repository.interface';
import type { IAudienceRepository } from './repositories/audience.repository.interface';
import type { NotificationCategory, SuppressionReason } from '@masternova/db';

/**
 * The send pipeline's rules are decisions, not queries: suppression outranks everything,
 * preferences apply only to optional categories, a duplicate event sends nothing, a failed
 * send is retryable. All four are provable with fakes, and none of them needs Postgres
 * (CLAUDE.md §6). Needing a database here would mean the repositories are not really
 * behind interfaces.
 */

class TestTemplate extends EmailTemplate<{ note: string }> {
  constructor(
    readonly key: string,
    readonly category: NotificationCategory,
  ) {
    super();
  }
  protected subjectFor(payload: { note: string }): string {
    return `Subject: ${payload.note}`;
  }
  protected previewFor(): string {
    return 'preview';
  }
  protected body(payload: { note: string }, ctx: RenderContext) {
    return (
      <p>
        {payload.note} at {ctx.webUrl}
      </p>
    );
  }
}

class FakeDeliveries implements IEmailDeliveryRepository {
  rows = new Map<string, { status: string; descriptor: DeliveryDescriptor; detail?: string }>();
  suppressed: { descriptor: DeliveryDescriptor; detail: string }[] = [];
  private seq = 0;

  private keyOf(d: DeliveryDescriptor) {
    return `${d.eventId}|${d.template}|${d.recipient}`;
  }

  claim(descriptor: DeliveryDescriptor): Promise<ClaimOutcome> {
    const key = this.keyOf(descriptor);
    const existing = this.rows.get(key);
    if (existing && existing.status !== 'FAILED') {
      return Promise.resolve({ claimed: false, reason: `already ${existing.status}` });
    }
    const id = existing ? key : `d${++this.seq}`;
    this.rows.set(key, { status: 'SENDING', descriptor });
    return Promise.resolve({ claimed: true, id: existing ? key : id });
  }

  markSent(id: string): Promise<void> {
    this.setStatus(id, 'SENT');
    return Promise.resolve();
  }

  markFailed(id: string, detail: string): Promise<void> {
    this.setStatus(id, 'FAILED', detail);
    return Promise.resolve();
  }

  recordSuppressed(descriptor: DeliveryDescriptor, detail: string): Promise<void> {
    this.suppressed.push({ descriptor, detail });
    this.rows.set(this.keyOf(descriptor), { status: 'SUPPRESSED', descriptor, detail });
    return Promise.resolve();
  }

  markByProviderMessageId(): Promise<number> {
    return Promise.resolve(0);
  }

  private setStatus(id: string, status: string, detail?: string) {
    for (const [key, row] of this.rows) {
      if (key === id || row.status === 'SENDING') {
        this.rows.set(key, { ...row, status, detail });
        return;
      }
    }
  }
}

class FakeAudience implements IAudienceRepository {
  suppressions = new Map<string, SuppressionReason>();
  optOuts = new Set<string>();

  suppressionFor(email: string) {
    const reason = this.suppressions.get(email);
    return Promise.resolve(reason ? { reason } : null);
  }

  hasOptedOut(userId: string, category: NotificationCategory) {
    return Promise.resolve(this.optOuts.has(`${userId}:${category}`));
  }

  emails = new Map<string, string>();

  emailFor(userId: string) {
    return Promise.resolve(this.emails.get(userId) ?? null);
  }
}

class FakeMail implements MailProvider {
  readonly name = 'fake';
  sent: OutboundMail[] = [];
  failWith?: Error;

  send(mail: OutboundMail) {
    if (this.failWith) throw this.failWith;
    this.sent.push(mail);
    return Promise.resolve({ providerMessageId: `msg-${this.sent.length}` });
  }
}

const CONFIG = {
  webUrl: 'https://masternova.test',
  apiUrl: 'https://api.masternova.test',
  unsubscribeSecret: 'a-test-secret-that-is-long-enough-32',
};

const build = (category: NotificationCategory = 'ACCOUNT_SECURITY') => {
  const deliveries = new FakeDeliveries();
  const audience = new FakeAudience();
  const mail = new FakeMail();
  const registry = new TemplateRegistry([new TestTemplate('test-template', category)]);
  const service = new NotificationService(registry, mail, deliveries, audience, CONFIG);
  return { service, deliveries, audience, mail };
};

const request = (over: Partial<Parameters<NotificationService['send']>[0]> = {}) => ({
  eventId: 'evt-1',
  templateKey: 'test-template',
  to: 'learner@masternova.test',
  userId: 'user-1',
  payload: { note: 'hello' },
  ...over,
});

describe('NotificationService', () => {
  it('renders and sends, recording the provider message id', async () => {
    const { service, mail } = build();

    await service.send(request());

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe('Subject: hello');
    expect(mail.sent[0].html).toContain('hello');
    expect(mail.sent[0].text).toContain('hello');
  });

  it('lowercases the recipient, so two spellings of one address dedupe together', async () => {
    const { service, mail } = build();

    await service.send(request({ to: '  Learner@Masternova.TEST ' }));

    expect(mail.sent[0].to).toBe('learner@masternova.test');
  });

  /** The property the whole module exists to provide (BUILD_PLAN §6.2). */
  it('sends exactly once when the same event is handled repeatedly', async () => {
    const { service, mail } = build();

    await service.send(request());
    await service.send(request());
    await service.send(request());

    expect(mail.sent).toHaveLength(1);
  });

  it('treats a different event for the same recipient as a new email', async () => {
    const { service, mail } = build();

    await service.send(request({ eventId: 'evt-1' }));
    await service.send(request({ eventId: 'evt-2' }));

    expect(mail.sent).toHaveLength(2);
  });

  it('does not send to a suppressed address, and says why in the delivery log', async () => {
    const { service, mail, audience, deliveries } = build();
    audience.suppressions.set('learner@masternova.test', 'HARD_BOUNCE');

    await service.send(request());

    expect(mail.sent).toHaveLength(0);
    expect(deliveries.suppressed[0].detail).toContain('HARD_BOUNCE');
  });

  /** A bounce is a fact about the mailbox, not a preference — it outranks even a receipt. */
  it('suppression beats a mandatory category', async () => {
    const { service, mail, audience } = build('ACCOUNT_SECURITY');
    audience.suppressions.set('learner@masternova.test', 'COMPLAINT');

    await service.send(request());

    expect(mail.sent).toHaveLength(0);
  });

  it('honours an opt-out on an optional category', async () => {
    const { service, mail, audience, deliveries } = build('PRODUCT_NEWS');
    audience.optOuts.add('user-1:PRODUCT_NEWS');

    await service.send(request());

    expect(mail.sent).toHaveLength(0);
    expect(deliveries.suppressed[0].detail).toContain('opted out');
  });

  /** You cannot unsubscribe from a password-reset link, so the preference is not consulted. */
  it('ignores an opt-out on a mandatory category', async () => {
    const { service, mail, audience } = build('ACCOUNT_SECURITY');
    audience.optOuts.add('user-1:ACCOUNT_SECURITY');

    await service.send(request());

    expect(mail.sent).toHaveLength(1);
  });

  it('attaches one-click unsubscribe headers only to optional categories', async () => {
    const optional = build('PRODUCT_NEWS');
    await optional.service.send(request());
    expect(optional.mail.sent[0].headers?.['List-Unsubscribe']).toContain(
      'https://api.masternova.test/api/notifications/unsubscribe/',
    );
    expect(optional.mail.sent[0].headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );

    const mandatory = build('ACCOUNT_SECURITY');
    await mandatory.service.send(request());
    expect(mandatory.mail.sent[0].headers).toBeUndefined();
  });

  it('shows the unsubscribe link in the body of an optional email and never in a mandatory one', async () => {
    const optional = build('PRODUCT_NEWS');
    await optional.service.send(request());
    expect(optional.mail.sent[0].html).toContain('/unsubscribe?token=');

    const mandatory = build('ACCOUNT_SECURITY');
    await mandatory.service.send(request());
    expect(mandatory.mail.sent[0].html).not.toContain('/unsubscribe');
  });

  /**
   * The failure must reach the caller, because the caller is an outbox handler and the
   * outbox is what owns the retry. Swallowing it here would mark the event handled and
   * lose the email for good.
   */
  it('records the failure and rethrows, so the outbox retries', async () => {
    const { service, mail, deliveries } = build();
    mail.failWith = new Error('smtp down');

    await expect(service.send(request())).rejects.toThrow('smtp down');
    expect([...deliveries.rows.values()][0].status).toBe('FAILED');
  });

  it('retries a previously failed send when the event is redelivered', async () => {
    const { service, mail } = build();
    mail.failWith = new Error('smtp down');
    await expect(service.send(request())).rejects.toThrow();

    mail.failWith = undefined;
    await service.send(request());

    expect(mail.sent).toHaveLength(1);
  });

  it('refuses an unknown template rather than silently sending nothing', async () => {
    const { service } = build();
    await expect(service.send(request({ templateKey: 'no-such-template' }))).rejects.toThrow(
      /no email template registered/,
    );
  });
});
