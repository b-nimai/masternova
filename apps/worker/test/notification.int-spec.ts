import { randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient } from '@masternova/db';
import { IdentityEvent } from '@masternova/contracts';
import { OutboxRelayService } from '../src/modules/outbox-relay/outbox-relay.service';
import { DomainEventDispatcher } from '../src/modules/outbox-relay/domain-event-dispatcher.service';
import { NotificationService } from '../src/modules/notification/notification.service';
import { TemplateRegistry } from '../src/modules/notification/templates/template.registry';
import { VerifyEmailTemplate } from '../src/modules/notification/templates/verify-email.template';
import { WelcomeTemplate } from '../src/modules/notification/templates/welcome.template';
import { PrismaEmailDeliveryRepository } from '../src/modules/notification/repositories/email-delivery.repository';
import { PrismaAudienceRepository } from '../src/modules/notification/repositories/audience.repository';
import { SendVerificationEmail } from '../src/modules/notification/handlers/identity-notification.handlers';
import type {
  MailProvider,
  OutboundMail,
} from '../src/modules/notification/mail/mail-provider.interface';
import type { PrismaService } from '../src/prisma/prisma.service';
import { startDatabase } from './setup-db';

/**
 * The claim that cannot be proved with a fake: **relay the same outbox row twice and the
 * learner still gets one email** (BUILD_PLAN §6.2).
 *
 * It needs a real database because the guarantee is a unique constraint doing its job
 * under a losing INSERT, and a fake repository would simply agree with whatever the test
 * asserted. Everything else in this module is unit-tested without Postgres.
 *
 * The mail provider is a fake, deliberately: the assertion is about how many times we
 * *called* a provider, not about SMTP.
 */
describe('notification pipeline (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  class CountingMail implements MailProvider {
    readonly name = 'counting';
    sent: OutboundMail[] = [];
    failTimes = 0;

    send(mail: OutboundMail) {
      if (this.failTimes > 0) {
        this.failTimes -= 1;
        throw new Error('provider unavailable');
      }
      this.sent.push(mail);
      return Promise.resolve({ providerMessageId: `msg-${this.sent.length}` });
    }
  }

  const CONFIG = {
    webUrl: 'https://masternova.test',
    apiUrl: 'https://api.masternova.test',
    unsubscribeSecret: 'integration-test-secret-long-enough-32',
  };

  const buildPipeline = (mail: CountingMail) => {
    const p = prisma as unknown as PrismaService;
    const notifications = new NotificationService(
      new TemplateRegistry([new VerifyEmailTemplate(), new WelcomeTemplate()]),
      mail,
      new PrismaEmailDeliveryRepository(p),
      new PrismaAudienceRepository(p),
      CONFIG,
    );
    const dispatcher = new DomainEventDispatcher(p);
    dispatcher.register(new SendVerificationEmail(notifications));
    return { notifications, relay: new OutboxRelayService(p, dispatcher) };
  };

  const seedVerificationEvent = async (email = 'learner@masternova.test') => {
    const eventId = randomUUID();
    await prisma.outboxMessage.create({
      data: {
        eventId,
        type: IdentityEvent.EmailVerificationRequested,
        aggregateType: 'User',
        aggregateId: 'user-1',
        payload: {
          email,
          name: 'Asha',
          token: 'verification-token',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    });
    return eventId;
  };

  beforeAll(async () => {
    ({ container, prisma } = await startDatabase());
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.emailDelivery.deleteMany();
    await prisma.emailSuppression.deleteMany();
    await prisma.processedEvent.deleteMany();
    await prisma.outboxMessage.deleteMany();
  });

  it('turns an outbox event into exactly one email and one delivery row', async () => {
    const mail = new CountingMail();
    const { relay } = buildPipeline(mail);
    const eventId = await seedVerificationEvent();

    await relay.tick();

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe('Confirm your email address');
    expect(mail.sent[0].html).toContain('verification-token');

    const delivery = await prisma.emailDelivery.findFirstOrThrow();
    expect(delivery).toMatchObject({
      eventId,
      template: 'verify-email',
      recipient: 'learner@masternova.test',
      status: 'SENT',
      providerMessageId: 'msg-1',
    });
  });

  /** ⭐ The BUILD_PLAN §6.2 test: relaying one row twice must not email twice. */
  it('sends once when the same outbox row is relayed again', async () => {
    const mail = new CountingMail();
    const { relay } = buildPipeline(mail);
    await seedVerificationEvent();

    await relay.tick();
    // Force redelivery of the same row, as a crashed relay past its visibility deadline
    // would: the message becomes claimable again with its eventId unchanged.
    await prisma.outboxMessage.updateMany({
      data: { status: 'PENDING', availableAt: new Date(Date.now() - 1000) },
    });
    await relay.tick();

    expect(mail.sent).toHaveLength(1);
    expect(await prisma.emailDelivery.count()).toBe(1);
  });

  /**
   * The same claim one layer lower. `ProcessedEvent` already stops the second dispatch, so
   * this bypasses it to prove the delivery table is independently sufficient — the two
   * defences are not one defence counted twice.
   */
  it('sends once even when the handler itself is invoked repeatedly', async () => {
    const mail = new CountingMail();
    const { notifications } = buildPipeline(mail);
    const eventId = randomUUID();

    const send = () =>
      notifications.send({
        eventId,
        templateKey: 'verify-email',
        to: 'learner@masternova.test',
        userId: 'user-1',
        payload: {
          email: 'learner@masternova.test',
          token: 't',
          expiresAt: new Date().toISOString(),
        },
      });

    await Promise.all([send(), send(), send(), send(), send()]);

    expect(mail.sent).toHaveLength(1);
    expect(await prisma.emailDelivery.count()).toBe(1);
  });

  it('leaves the message unpublished when the provider fails, then sends on the retry', async () => {
    const mail = new CountingMail();
    mail.failTimes = 1;
    const { relay } = buildPipeline(mail);
    await seedVerificationEvent();

    await relay.tick();

    expect(mail.sent).toHaveLength(0);
    expect(await prisma.emailDelivery.findFirstOrThrow()).toMatchObject({ status: 'FAILED' });
    const failed = await prisma.outboxMessage.findFirstOrThrow();
    expect(failed.status).toBe('PENDING');
    expect(failed.lastError).toContain('provider unavailable');

    // The relay's backoff pushed availableAt forward; move it back rather than waiting.
    await prisma.outboxMessage.updateMany({ data: { availableAt: new Date(Date.now() - 1000) } });
    await relay.tick();

    expect(mail.sent).toHaveLength(1);
    expect(await prisma.emailDelivery.findFirstOrThrow()).toMatchObject({
      status: 'SENT',
      attempts: 2,
    });
    expect((await prisma.outboxMessage.findFirstOrThrow()).status).toBe('PUBLISHED');
  });

  it('does not send to a suppressed address, and records why', async () => {
    const mail = new CountingMail();
    const { relay } = buildPipeline(mail);
    await prisma.emailSuppression.create({
      data: { email: 'learner@masternova.test', reason: 'HARD_BOUNCE' },
    });
    await seedVerificationEvent();

    await relay.tick();

    expect(mail.sent).toHaveLength(0);
    const delivery = await prisma.emailDelivery.findFirstOrThrow();
    expect(delivery.status).toBe('SUPPRESSED');
    expect(delivery.detail).toContain('HARD_BOUNCE');
    // Suppression is not a failure: the message is settled, not retried forever.
    expect((await prisma.outboxMessage.findFirstOrThrow()).status).toBe('PUBLISHED');
  });

  it('respects an opt-out on an optional category and ignores one on a mandatory category', async () => {
    const mail = new CountingMail();
    const { notifications } = buildPipeline(mail);
    await prisma.user.create({
      data: { id: 'user-opt', email: 'opt@masternova.test', name: 'Opt' },
    });
    await prisma.notificationPreference.createMany({
      data: [
        { userId: 'user-opt', category: 'PRODUCT_NEWS', enabled: false },
        { userId: 'user-opt', category: 'ACCOUNT_SECURITY', enabled: false },
      ],
    });

    await notifications.send({
      eventId: randomUUID(),
      templateKey: 'welcome',
      to: 'opt@masternova.test',
      userId: 'user-opt',
      payload: { email: 'opt@masternova.test', name: 'Opt' },
    });
    await notifications.send({
      eventId: randomUUID(),
      templateKey: 'verify-email',
      to: 'opt@masternova.test',
      userId: 'user-opt',
      payload: { email: 'opt@masternova.test', token: 't', expiresAt: new Date().toISOString() },
    });

    expect(mail.sent.map((m) => m.subject)).toEqual(['Confirm your email address']);
  });
});
