import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient } from '@masternova/db';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { startDatabase } from './setup-db';

/**
 * Identity end-to-end against a real database. The claims worth proving are refresh
 * rotation, reuse detection, and that a password reset actually invalidates what an
 * attacker is holding.
 */
describe('identity (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let app: NestFastifyApplication;

  const CREDS = { email: 'learner@masternova.in', password: 'correct-horse-battery' };

  const post = (url: string, payload: object, cookies: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api${url}`, payload, cookies });

  const cookiesOf = (res: { cookies: { name: string; value: string }[] }) =>
    Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));

  const register = async () => {
    await post('/auth/register', CREDS);
    const login = await post('/auth/login', CREDS);
    return cookiesOf(login);
  };

  beforeAll(async () => {
    ({ container, prisma } = await startDatabase());
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET as string });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.outboxMessage.deleteMany();
    await prisma.user.deleteMany();
  });

  it('registers, publishing the events that notification will react to', async () => {
    const res = await post('/auth/register', CREDS);
    expect(res.statusCode).toBe(201);

    const types = (await prisma.outboxMessage.findMany()).map((m) => m.type).sort();
    expect(types).toEqual(['identity.email.verification_requested', 'identity.user.registered']);
  });

  it('rejects a duplicate email', async () => {
    await post('/auth/register', CREDS);
    expect((await post('/auth/register', CREDS)).statusCode).toBe(409);
  });

  it('does not reveal whether an account exists', async () => {
    await post('/auth/register', CREDS);
    const wrongPassword = await post('/auth/login', { ...CREDS, password: 'wrong-password-here' });
    const noSuchUser = await post('/auth/login', {
      email: 'nobody@masternova.in',
      password: 'wrong-password-here',
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(JSON.parse(wrongPassword.body).message).toBe(JSON.parse(noSuchUser.body).message);
  });

  it('logs in, setting httpOnly cookies with the refresh scoped to its own path', async () => {
    await post('/auth/register', CREDS);
    const res = await post('/auth/login', CREDS);

    const access = res.cookies.find((c) => c.name === 'masternova_access');
    const refresh = res.cookies.find((c) => c.name === 'masternova_refresh');

    expect(access).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(refresh).toMatchObject({ httpOnly: true, path: '/api/auth/refresh' });
  });

  it('authenticates /auth/me by cookie and rejects it without one', async () => {
    const cookies = await register();

    const authed = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(authed.statusCode).toBe(200);
    expect(JSON.parse(authed.body).email).toBe(CREDS.email);
    expect(anon.statusCode).toBe(401);
  });

  it('rotates the refresh token, issuing a different one each time', async () => {
    const cookies = await register();
    const first = cookies.masternova_refresh;

    const refreshed = await post('/auth/refresh', {}, { masternova_refresh: first });
    const second = cookiesOf(refreshed).masternova_refresh;

    expect(refreshed.statusCode).toBe(200);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  /**
   * ⭐ The headline behaviour. A token that has already been rotated arriving again means
   * the chain leaked — the honest client has moved on. We cannot tell attacker from victim,
   * so the whole session dies.
   */
  it('detects refresh-token reuse and kills the entire session', async () => {
    const cookies = await register();
    const stolen = cookies.masternova_refresh;

    // The legitimate client refreshes; `stolen` is now spent.
    const legit = await post('/auth/refresh', {}, { masternova_refresh: stolen });
    const rotated = cookiesOf(legit).masternova_refresh;

    // The attacker replays the copy they captured earlier.
    const replay = await post('/auth/refresh', {}, { masternova_refresh: stolen });
    expect(replay.statusCode).toBe(401);

    // ...and the victim's freshly-rotated token is dead too.
    const victim = await post('/auth/refresh', {}, { masternova_refresh: rotated });
    expect(victim.statusCode).toBe(401);

    const session = await prisma.session.findFirstOrThrow();
    expect(session.revokedAt).not.toBeNull();
    expect(session.revokedReason).toBe('REUSE_DETECTED');
  });

  it('rejects a refresh token that was never issued', async () => {
    await register();
    const res = await post('/auth/refresh', {}, { masternova_refresh: 'not-a-real-token' });
    expect(res.statusCode).toBe(401);
  });

  it('revokes only the current device on logout, leaving others signed in', async () => {
    await post('/auth/register', CREDS);
    const phone = cookiesOf(await post('/auth/login', CREDS));
    const laptop = cookiesOf(await post('/auth/login', CREDS));

    await post('/auth/logout', {}, { masternova_access: phone.masternova_access });

    const laptopStillWorks = await post(
      '/auth/refresh',
      {},
      { masternova_refresh: laptop.masternova_refresh },
    );
    expect(laptopStillWorks.statusCode).toBe(200);
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('signs out everywhere on logout-all', async () => {
    await post('/auth/register', CREDS);
    const phone = cookiesOf(await post('/auth/login', CREDS));
    const laptop = cookiesOf(await post('/auth/login', CREDS));

    await post('/auth/logout-all', {}, { masternova_access: phone.masternova_access });

    const res = await post('/auth/refresh', {}, { masternova_refresh: laptop.masternova_refresh });
    expect(res.statusCode).toBe(401);
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('verifies an email with the token carried on the outbox event', async () => {
    await post('/auth/register', CREDS);
    const event = await prisma.outboxMessage.findFirstOrThrow({
      where: { type: 'identity.email.verification_requested' },
    });
    const { token } = event.payload as { token: string };

    expect((await post('/auth/verify-email', { token })).statusCode).toBe(204);
    expect((await prisma.user.findFirstOrThrow()).emailVerified).not.toBeNull();

    // Single use.
    expect((await post('/auth/verify-email', { token })).statusCode).toBe(400);
  });

  it('answers forgot-password identically for known and unknown addresses', async () => {
    await post('/auth/register', CREDS);
    const known = await post('/auth/forgot-password', { email: CREDS.email });
    const unknown = await post('/auth/forgot-password', { email: 'ghost@masternova.in' });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
  });

  /** A reset exists because you fear a session is compromised; it must actually end them. */
  it('resets the password and revokes every existing session', async () => {
    await post('/auth/register', CREDS);
    const attacker = cookiesOf(await post('/auth/login', CREDS));

    await post('/auth/forgot-password', { email: CREDS.email });
    const event = await prisma.outboxMessage.findFirstOrThrow({
      where: { type: 'identity.password.reset_requested' },
    });
    const { token } = event.payload as { token: string };

    expect(
      (await post('/auth/reset-password', { token, password: 'a-brand-new-password' })).statusCode,
    ).toBe(204);

    const stillAlive = await post(
      '/auth/refresh',
      {},
      { masternova_refresh: attacker.masternova_refresh },
    );
    expect(stillAlive.statusCode).toBe(401);

    expect((await post('/auth/login', CREDS)).statusCode).toBe(401);
    expect(
      (await post('/auth/login', { email: CREDS.email, password: 'a-brand-new-password' }))
        .statusCode,
    ).toBe(200);
  });

  it('lists sessions and revokes one by id', async () => {
    await post('/auth/register', CREDS);
    const phone = cookiesOf(await post('/auth/login', CREDS));
    await post('/auth/login', CREDS);

    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      cookies: { masternova_access: phone.masternova_access },
    });
    const sessions = JSON.parse(list.body) as { id: string }[];
    expect(sessions).toHaveLength(2);
    // Never leak the credential material.
    expect(list.body).not.toContain('tokenHash');

    const target = sessions.find((s) => s.id)!;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${target.id}`,
      cookies: { masternova_access: phone.masternova_access },
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(1);
  });
});
