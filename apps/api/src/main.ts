import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigType } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from './app.module';
import { appConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  const { port, cookieSecret } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  /**
   * Plain signed cookies, not an encrypted session blob.
   *
   * The previous design stored `userId` in a libsodium-encrypted cookie, which is
   * server-stateless and therefore cannot be revoked: signing out on one device leaves
   * every other cookie valid until it expires. Identity now issues a short-lived access
   * token plus a rotating refresh token backed by a `Session` row, so revocation is real
   * and reuse is detectable (ADR-0010). Nothing secret lives in a cookie value, so
   * signing is enough — the access token is itself signed, and the refresh token is an
   * opaque lookup key into a table we control.
   */
  await app.register(fastifyCookie, { secret: cookieSecret });

  // Every route is served under /api (PROJECT_PLAN.md §2 global prefix).
  app.setGlobalPrefix('api');

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[api] listening on http://localhost:${port}/api`);
}

void bootstrap();
