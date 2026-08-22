import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigType } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifySecureSession from '@fastify/secure-session';
import { AppModule } from './app.module';
import { appConfig, sessionConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  const session = app.get<ConfigType<typeof sessionConfig>>(sessionConfig.KEY);
  const { port, isProduction } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  // First-party, encrypted session cookie (libsodium). Passport strategies validate
  // credentials; we persist `userId` here ourselves. In prod the Ingress serves api +
  // web on one origin, so SameSite=Lax is enough (PROJECT_PLAN.md §2). The key is
  // derived from SESSION_SECRET (>=32 chars) + a fixed 16-char SESSION_SALT.
  await app.register(fastifySecureSession, {
    cookieName: 'masternova_session',
    secret: session.secret,
    salt: session.salt,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 60 * 60 * 24 * 7, // 7 days
    },
  });

  // Every route is served under /api (PROJECT_PLAN.md §2 global prefix).
  app.setGlobalPrefix('api');

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[api] listening on http://localhost:${port}/api`);
}

void bootstrap();
