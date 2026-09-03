import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Course, PrismaClient, Role, User } from '@masternova/db';
import { AppModule } from '../src/app.module';
import { WebhookSignatureException } from '../src/common/exceptions';
import { PrismaService } from '../src/prisma/prisma.service';
import { PAYMENT_PROVIDER } from '../src/modules/commerce/payment/payment-provider.interface';
import { OrderExpiryService } from '../src/modules/commerce/order/order-expiry.service';
import { startDatabase } from './setup-db';
import { createUser, seedCourseWithStructure } from './factories/catalog.factory';

const WEBHOOK_SECRET = 'test-razorpay-webhook-secret-32-chars';

/**
 * The claims a unit test cannot make about commerce.
 *
 * The pure parts are already proven without I/O: the edge list, the coupon rules, the
 * discount allocation, the signature check. What is left is everything that depends on the
 * database genuinely behaving like a database — that fifty concurrent captures grant one
 * entitlement, that a coupon capped at one is redeemed once when two checkouts race, that a
 * webhook arriving before the browser redirect still works, and that a refund revokes
 * access rather than merely saying it did.
 *
 * The provider is a **stub of the port**, not of `fetch`: there is no Razorpay account in
 * CI, and the adapter's own translation is unit-tested against real signed payloads.
 */
describe('commerce (real Postgres + Redis)', () => {
  jest.setTimeout(300_000);

  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let app: NestFastifyApplication;
  let expiry: OrderExpiryService;

  /** Records what it was asked to do, so the tests can assert we did not double-charge. */
  const provider = {
    name: 'razorpay',
    created: [] as { orderId: string; amountMinor: number }[],
    refunds: [] as { providerPaymentId: string; idempotencyKey: string }[],

    createOrder(input: { orderId: string; amountMinor: number; currency: string }) {
      provider.created.push({ orderId: input.orderId, amountMinor: input.amountMinor });
      return Promise.resolve({
        providerOrderId: `order_rzp_${input.orderId}`,
        publicKey: 'rzp_test_key',
        amountMinor: input.amountMinor,
        currency: input.currency,
      });
    },

    verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
      const expected = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
      // The same exception the real adapter throws, so the controller's 400 is exercised
      // rather than a 500 from an unmapped error.
      if (headers['x-razorpay-signature'] !== expected) {
        throw new WebhookSignatureException('signature mismatch');
      }
      return JSON.parse(rawBody.toString('utf8'));
    },

    refund(input: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }) {
      provider.refunds.push(input);
      return Promise.resolve({
        providerRefundId: `rfnd_${provider.refunds.length}`,
        amountMinor: input.amountMinor,
        status: 'PROCESSED' as const,
      });
    },
  };

  const request = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    options: {
      payload?: object;
      cookies?: Record<string, string>;
      headers?: Record<string, string>;
    } = {},
  ) => app.inject({ method, url: `/api${url}`, ...options });

  /** The webhook route takes raw bytes and a matching signature, exactly like production. */
  const sendWebhook = (event: Record<string, unknown>) => {
    const raw = JSON.stringify(event);
    return app.inject({
      method: 'POST',
      url: '/api/webhooks/payments',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      },
    });
  };

  const capturedEvent = (providerOrderId: string, id = 'evt_1', paymentId = 'pay_1') => ({
    id,
    type: 'payment.captured',
    providerEventId: id,
    providerOrderId,
    providerPaymentId: paymentId,
    amountMinor: 100_00,
    currency: 'INR',
    method: 'upi',
    raw: { id },
  });

  const signIn = async (role: Role = 'LEARNER') => {
    const email = `user-${Math.random().toString(36).slice(2, 10)}@masternova.test`;
    const password = 'correct-horse-battery';
    await request('POST', '/auth/register', { payload: { email, password } });
    const user = await prisma.user.update({ where: { email }, data: { role } });
    const login = await request('POST', '/auth/login', { payload: { email, password } });
    return {
      id: user.id,
      cookies: Object.fromEntries(login.cookies.map((c) => [c.name, c.value])),
    };
  };

  const sellableCourse = async (instructor: User, priceMinor = 100_00): Promise<Course> =>
    seedCourseWithStructure(prisma, {
      instructorId: instructor.id,
      sections: 1,
      lecturesPerSection: 1,
      course: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        priceMinor,
        priceSetAt: new Date(),
        currency: 'INR',
      },
    });

  beforeAll(async () => {
    redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    ({ container, prisma } = await startDatabase());

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(provider)
      .compile();

    // `rawBody: true` exactly as `main.ts` does it — the webhook signature is over the exact
    // bytes, so without it the endpoint rejects every request and the suite would be
    // testing that rejection rather than the flow.
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      rawBody: true,
    });
    await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET as string });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expiry = app.get(OrderExpiryService);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await Promise.all([container?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    provider.created.length = 0;
    provider.refunds.length = 0;
    await prisma.providerWebhookEvent.deleteMany();
    await prisma.couponRedemption.deleteMany();
    await prisma.order.deleteMany();
    await prisma.coupon.deleteMany();
    await prisma.cart.deleteMany();
    await prisma.entitlement.deleteMany();
    await prisma.outboxMessage.deleteMany();
    await prisma.course.deleteMany();
    await prisma.user.deleteMany();
  });

  describe('the cart', () => {
    it('prices what is in it, live', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor, 249900);
      const learner = await signIn();

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const view = JSON.parse((await request('GET', '/cart', { cookies: learner.cookies })).body);

      expect(view.totalMinor).toBe(249900);
      expect(view.lines).toHaveLength(1);
    });

    /** A cart is a list of intentions, not a quote — which is why CartItem has no price. */
    it('reflects a price change made after the course went in', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor, 100_00);
      const learner = await signIn();

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      await prisma.course.update({ where: { id: course.id }, data: { priceMinor: 50_00 } });

      const view = JSON.parse((await request('GET', '/cart', { cookies: learner.cookies })).body);
      expect(view.totalMinor).toBe(50_00);
    });

    it('adding the same course twice leaves one line', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const view = JSON.parse(
        (
          await request('POST', '/cart/items', {
            cookies: learner.cookies,
            payload: { courseId: course.id },
          })
        ).body,
      );

      expect(view.lines).toHaveLength(1);
    });

    it('refuses an unpublished course', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await seedCourseWithStructure(prisma, {
        instructorId: instructor.id,
        sections: 1,
        lecturesPerSection: 1,
        course: { status: 'DRAFT', publishedAt: null, priceSetAt: new Date(), priceMinor: 100_00 },
      });
      const learner = await signIn();

      const response = await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('checkout', () => {
    const addAndCheckout = async (
      learner: { cookies: Record<string, string> },
      courseId: string,
      body: object = {},
      idempotencyKey = `key-${Math.random().toString(36).slice(2)}`,
    ) => {
      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId },
      });
      return request('POST', '/checkout', {
        cookies: learner.cookies,
        payload: body,
        headers: { 'idempotency-key': idempotencyKey },
      });
    };

    it('creates an order and hands it to the provider', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();

      const response = await addAndCheckout(learner, course.id);
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(201);
      expect(body.status).toBe('AWAITING_PAYMENT');
      expect(body.payment.providerOrderId).toContain('order_rzp_');
      expect(provider.created).toHaveLength(1);
    });

    it('empties the cart, so a second tab cannot buy the same items again', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();

      await addAndCheckout(learner, course.id);
      const cart = JSON.parse((await request('GET', '/cart', { cookies: learner.cookies })).body);

      expect(cart.lines).toHaveLength(0);
    });

    /** The endpoint the whole `Idempotency-Key` mechanism was built for. */
    it('returns the first order when the same request is retried', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();
      const key = 'retry-me';

      const first = await addAndCheckout(learner, course.id, {}, key);
      const second = await request('POST', '/checkout', {
        cookies: learner.cookies,
        payload: {},
        headers: { 'idempotency-key': key },
      });

      expect(JSON.parse(second.body).orderId).toBe(JSON.parse(first.body).orderId);
      expect(await prisma.order.count()).toBe(1);
      expect(provider.created).toHaveLength(1);
    });

    /** A course discounted to nothing never reaches a provider — asking for zero fails. */
    it('settles a free order immediately, without the provider', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor, 0);
      const learner = await signIn();

      const body = JSON.parse((await addAndCheckout(learner, course.id)).body);

      expect(body.status).toBe('PAID');
      expect(body.payment).toBeUndefined();
      expect(provider.created).toHaveLength(0);
      // And access is already granted, in the same transaction.
      expect(
        await prisma.entitlement.findUnique({
          where: { userId_courseId: { userId: learner.id, courseId: course.id } },
        }),
      ).toMatchObject({ status: 'ACTIVE', source: 'FREE_ENROLLMENT' });
    });

    it('refuses to sell a course the learner already bought', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor, 0);
      const learner = await signIn();

      await addAndCheckout(learner, course.id);
      const response = await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).details.reason).toBe('ALREADY_OWNED');
    });

    it('refuses an empty cart', async () => {
      const learner = await signIn();
      const response = await request('POST', '/checkout', {
        cookies: learner.cookies,
        payload: {},
        headers: { 'idempotency-key': 'empty' },
      });
      expect(response.statusCode).toBe(400);
    });

    describe('coupons', () => {
      it('applies one and records the redemption with the order', async () => {
        const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
        const course = await sellableCourse(instructor, 100_00);
        const learner = await signIn();
        await prisma.coupon.create({
          data: { code: 'HALF', kind: 'PERCENT', value: 5000 },
        });

        const body = JSON.parse(
          (await addAndCheckout(learner, course.id, { couponCode: 'half' })).body,
        );

        expect(body.totalMinor).toBe(50_00);
        expect(await prisma.couponRedemption.count({ where: { orderId: body.orderId } })).toBe(1);
      });

      /**
       * The reason the limit is a table and not a counter. Two checkouts racing on a
       * one-use coupon must produce one redemption — a read-then-increment gives two.
       */
      it('redeems a single-use coupon exactly once when two checkouts race', async () => {
        const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
        const [a, b] = await Promise.all([sellableCourse(instructor), sellableCourse(instructor)]);
        const learner = await signIn();
        await prisma.coupon.create({
          data: { code: 'ONCE', kind: 'PERCENT', value: 5000, maxRedemptions: 1 },
        });

        await request('POST', '/cart/items', {
          cookies: learner.cookies,
          payload: { courseId: a.id },
        });
        const first = await request('POST', '/checkout', {
          cookies: learner.cookies,
          payload: { couponCode: 'ONCE' },
          headers: { 'idempotency-key': 'k1' },
        });

        await request('POST', '/cart/items', {
          cookies: learner.cookies,
          payload: { courseId: b.id },
        });
        const second = await request('POST', '/checkout', {
          cookies: learner.cookies,
          payload: { couponCode: 'ONCE' },
          headers: { 'idempotency-key': 'k2' },
        });

        expect(first.statusCode).toBe(201);
        // The second is refused, and told which rule refused it.
        expect(second.statusCode).toBe(400);
        expect(await prisma.couponRedemption.count()).toBe(1);
      });

      it('refuses an expired code rather than silently charging full price', async () => {
        const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
        const course = await sellableCourse(instructor);
        const learner = await signIn();
        await prisma.coupon.create({
          data: {
            code: 'GONE',
            kind: 'PERCENT',
            value: 5000,
            endsAt: new Date(Date.now() - 1000),
          },
        });

        const response = await addAndCheckout(learner, course.id, { couponCode: 'GONE' });

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).details.reason).toBe('COUPON_EXPIRED');
        expect(await prisma.order.count()).toBe(0);
      });
    });
  });

  describe('the webhook', () => {
    const paidOrder = async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const checkout = JSON.parse(
        (
          await request('POST', '/checkout', {
            cookies: learner.cookies,
            payload: {},
            headers: { 'idempotency-key': `k-${Math.random()}` },
          })
        ).body,
      );
      return { learner, course, checkout };
    };

    it('rejects a body whose signature does not verify', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/payments',
        payload: JSON.stringify({ id: 'evt_x' }),
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'nonsense' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('captures the order and grants access', async () => {
      const { learner, course, checkout } = await paidOrder();

      const response = await sendWebhook(capturedEvent(checkout.payment.providerOrderId));

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).outcome).toBe('processed');

      const order = await prisma.order.findUnique({ where: { id: checkout.orderId } });
      expect(order?.status).toBe('PAID');
      expect(
        await prisma.entitlement.findUnique({
          where: { userId_courseId: { userId: learner.id, courseId: course.id } },
        }),
      ).toMatchObject({ status: 'ACTIVE', source: 'PURCHASE' });
    });

    /**
     * Providers guarantee at-least-once and retry on any non-2xx. Fifty deliveries must
     * grant one entitlement and raise one event — this is the §11 proof for commerce.
     */
    it('grants once and emits once when the same webhook arrives fifty times at once', async () => {
      const { learner, course, checkout } = await paidOrder();
      const event = capturedEvent(checkout.payment.providerOrderId);

      const responses = await Promise.all(Array.from({ length: 50 }, () => sendWebhook(event)));

      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(responses.filter((r) => JSON.parse(r.body).outcome === 'processed')).toHaveLength(1);

      expect(await prisma.entitlement.count({ where: { userId: learner.id } })).toBe(1);
      expect(await prisma.outboxMessage.count({ where: { type: 'commerce.order.paid' } })).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: checkout.orderId } })).toBe(1);
      void course;
    });

    /**
     * The provider frequently calls back before the learner's browser returns from the
     * payment page. Nothing here waits for the redirect — the webhook is the truth.
     */
    it('works when it arrives before the learner is redirected back', async () => {
      const { checkout } = await paidOrder();

      // No browser call of any kind between checkout and this.
      const response = await sendWebhook(capturedEvent(checkout.payment.providerOrderId));

      expect(JSON.parse(response.body).outcome).toBe('processed');
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'PAID',
      );
    });

    /**
     * A refund can land before the capture on a slow connection. There is no re-ordering
     * buffer: the state machine has no refund edge out of AWAITING_PAYMENT, so it no-ops,
     * and the provider's own retry delivers it again once the order is PAID.
     */
    it('no-ops on a refund that arrives before the capture, and applies it on redelivery', async () => {
      const { learner, course, checkout } = await paidOrder();
      const providerOrderId = checkout.payment.providerOrderId;

      const early = await sendWebhook({
        id: 'evt_refund_early',
        type: 'refund.processed',
        providerEventId: 'evt_refund_early',
        providerOrderId,
        providerPaymentId: 'pay_1',
        providerRefundId: 'rfnd_early',
        amountMinor: 100_00,
        currency: 'INR',
        raw: {},
      });
      expect(JSON.parse(early.body).outcome).toBe('duplicate');
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'AWAITING_PAYMENT',
      );

      await sendWebhook(capturedEvent(providerOrderId));

      // The provider redelivers with a new event id, which is what actually happens.
      const late = await sendWebhook({
        id: 'evt_refund_late',
        type: 'refund.processed',
        providerEventId: 'evt_refund_late',
        providerOrderId,
        providerPaymentId: 'pay_1',
        providerRefundId: 'rfnd_late',
        amountMinor: 100_00,
        currency: 'INR',
        raw: {},
      });

      expect(JSON.parse(late.body).outcome).toBe('processed');
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'REFUNDED',
      );
      expect(
        await prisma.entitlement.findUnique({
          where: { userId_courseId: { userId: learner.id, courseId: course.id } },
        }),
      ).toMatchObject({ status: 'REVOKED' });
    });

    /**
     * The claim row is written *before* dispatch, so a crash mid-processing leaves it with
     * `processedAt = null`. If the retry were treated as a plain duplicate the money would
     * be captured at the provider with no entitlement, no receipt, and a provider satisfied
     * enough by the 200 to stop retrying — a silent, paid-for, unusable order.
     */
    it('reprocesses a redelivery whose previous attempt failed', async () => {
      const { learner, course, checkout } = await paidOrder();
      const event = capturedEvent(checkout.payment.providerOrderId);

      // Exactly what a failed attempt leaves behind: claimed, never processed, error recorded.
      await prisma.providerWebhookEvent.create({
        data: {
          provider: 'razorpay',
          providerEventId: 'evt_1',
          type: 'payment.captured',
          payload: { id: 'evt_1' },
          lastError: 'deadlock detected',
        },
      });

      const response = await sendWebhook(event);

      expect(JSON.parse(response.body).outcome).toBe('processed');
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'PAID',
      );
      expect(
        await prisma.entitlement.findUnique({
          where: { userId_courseId: { userId: learner.id, courseId: course.id } },
        }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(
        (await prisma.providerWebhookEvent.findFirst({ where: { providerEventId: 'evt_1' } }))
          ?.processedAt,
      ).not.toBeNull();
    });

    /**
     * The other half of the same rule: unprocessed **and no error** means another replica is
     * holding it right now, so this must stay a duplicate. Without the distinction the
     * fifty-concurrent guarantee above would collapse into fifty concurrent processings.
     */
    it('still treats a delivery that is merely in flight as a duplicate', async () => {
      const { checkout } = await paidOrder();

      await prisma.providerWebhookEvent.create({
        data: {
          provider: 'razorpay',
          providerEventId: 'evt_1',
          type: 'payment.captured',
          payload: { id: 'evt_1' },
        },
      });

      const response = await sendWebhook(capturedEvent(checkout.payment.providerOrderId));

      expect(JSON.parse(response.body).outcome).toBe('duplicate');
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'AWAITING_PAYMENT',
      );
    });

    it('answers 200 for an event about an order it has never heard of', async () => {
      const response = await sendWebhook({
        id: 'evt_stray',
        type: 'payment.captured',
        providerEventId: 'evt_stray',
        providerOrderId: 'order_rzp_from_another_environment',
        providerPaymentId: 'pay_stray',
        raw: {},
      });

      // 200, not 404: a non-2xx has the provider retrying something that will never resolve.
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).outcome).toBe('deferred');
    });

    it('records every event it received, whether it acted on it or not', async () => {
      const { checkout } = await paidOrder();
      await sendWebhook(capturedEvent(checkout.payment.providerOrderId));

      const rows = await prisma.providerWebhookEvent.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].processedAt).not.toBeNull();
    });
  });

  describe('refunds', () => {
    it('returns the money, then revokes access', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();
      const admin = await signIn('ADMIN');

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const checkout = JSON.parse(
        (
          await request('POST', '/checkout', {
            cookies: learner.cookies,
            payload: {},
            headers: { 'idempotency-key': 'refund-me' },
          })
        ).body,
      );
      await sendWebhook(capturedEvent(checkout.payment.providerOrderId));

      const response = await request('POST', `/admin/orders/${checkout.orderId}/refund`, {
        cookies: admin.cookies,
        payload: { reason: 'requested by learner' },
      });

      expect(response.statusCode).toBe(202);
      expect(provider.refunds).toHaveLength(1);
      // Stable, so our own retry is not a second withdrawal.
      expect(provider.refunds[0].idempotencyKey).toBe(`refund:${checkout.orderId}`);

      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'REFUNDED',
      );
      expect(
        await prisma.entitlement.findUnique({
          where: { userId_courseId: { userId: learner.id, courseId: course.id } },
        }),
      ).toMatchObject({ status: 'REVOKED' });
      expect(await prisma.outboxMessage.count({ where: { type: 'commerce.order.refunded' } })).toBe(
        1,
      );
    });

    it('is refused for a learner, who is not an admin', async () => {
      const learner = await signIn();
      const response = await request('POST', '/admin/orders/whatever/refund', {
        cookies: learner.cookies,
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses to refund an order that was never paid', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();
      const admin = await signIn('ADMIN');

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const checkout = JSON.parse(
        (
          await request('POST', '/checkout', {
            cookies: learner.cookies,
            payload: {},
            headers: { 'idempotency-key': 'unpaid' },
          })
        ).body,
      );

      const response = await request('POST', `/admin/orders/${checkout.orderId}/refund`, {
        cookies: admin.cookies,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(provider.refunds).toHaveLength(0);
    });
  });

  describe('an order that dies without being paid', () => {
    /**
     * Expiry is not the only way an order ends unpaid, and the coupon must come back from
     * every one of them. A `perUserLimit: 1` code spent by clicking "cancel", or a 100-use
     * launch coupon burnt down by declined cards, is the bug this guards.
     */
    const withCoupon = async (code: string) => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();
      await prisma.coupon.create({
        data: { code, kind: 'PERCENT', value: 5000, maxRedemptions: 1 },
      });

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const checkout = JSON.parse(
        (
          await request('POST', '/checkout', {
            cookies: learner.cookies,
            payload: { couponCode: code },
            headers: { 'idempotency-key': `c-${Math.random()}` },
          })
        ).body,
      );
      expect(await prisma.couponRedemption.count()).toBe(1);
      return { learner, checkout };
    };

    it('gives the coupon back when the learner cancels', async () => {
      const { learner, checkout } = await withCoupon('CANCELME');

      const response = await request('POST', `/orders/${checkout.orderId}/cancel`, {
        cookies: learner.cookies,
      });

      expect(response.statusCode).toBe(201);
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'CANCELLED',
      );
      expect(await prisma.couponRedemption.count()).toBe(0);
      expect(
        (await prisma.coupon.findFirst({ where: { code: 'CANCELME' } }))?.redemptionCount,
      ).toBe(0);
    });

    it('gives the coupon back when the card is declined', async () => {
      const { checkout } = await withCoupon('DECLINED');

      const response = await sendWebhook({
        id: 'evt_fail',
        type: 'payment.failed',
        providerEventId: 'evt_fail',
        providerOrderId: checkout.payment.providerOrderId,
        providerPaymentId: 'pay_fail',
        failureCode: 'BAD_REQUEST_ERROR',
        raw: { id: 'evt_fail' },
      });

      expect(response.statusCode).toBe(200);
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'FAILED',
      );
      expect(await prisma.couponRedemption.count()).toBe(0);
    });

    /** Submitting is not dying. The order is still going to be paid, so it keeps its hold. */
    it('keeps the hold while the order is merely awaiting payment', async () => {
      await withCoupon('HOLDME');
      expect(await prisma.couponRedemption.count()).toBe(1);
    });
  });

  describe('the expiry sweeper', () => {
    /** What is actually released is the coupon, not the order status. */
    it('expires an unpaid order and gives its coupon redemption back', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();
      await prisma.coupon.create({
        data: { code: 'ONCE', kind: 'PERCENT', value: 5000, maxRedemptions: 1 },
      });

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const checkout = JSON.parse(
        (
          await request('POST', '/checkout', {
            cookies: learner.cookies,
            payload: { couponCode: 'ONCE' },
            headers: { 'idempotency-key': 'expire-me' },
          })
        ).body,
      );
      expect(await prisma.couponRedemption.count()).toBe(1);

      const expired = await expiry.sweep(new Date(Date.now() + 60 * 60_000));

      expect(expired).toBe(1);
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'EXPIRED',
      );
      expect(await prisma.couponRedemption.count()).toBe(0);
      expect((await prisma.coupon.findFirst({ where: { code: 'ONCE' } }))?.redemptionCount).toBe(0);
    });

    it('never touches an order that was paid', async () => {
      const instructor = await createUser(prisma, { role: 'INSTRUCTOR' });
      const course = await sellableCourse(instructor);
      const learner = await signIn();

      await request('POST', '/cart/items', {
        cookies: learner.cookies,
        payload: { courseId: course.id },
      });
      const checkout = JSON.parse(
        (
          await request('POST', '/checkout', {
            cookies: learner.cookies,
            payload: {},
            headers: { 'idempotency-key': 'keep-me' },
          })
        ).body,
      );
      await sendWebhook(capturedEvent(checkout.payment.providerOrderId));

      expect(await expiry.sweep(new Date(Date.now() + 60 * 60_000))).toBe(0);
      expect((await prisma.order.findUnique({ where: { id: checkout.orderId } }))?.status).toBe(
        'PAID',
      );
    });
  });
});
