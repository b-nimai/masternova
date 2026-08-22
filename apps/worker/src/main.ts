import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  // No HTTP server — a standalone DI context that owns the BullMQ consumers (§7).
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  new Logger('worker').log('worker context started');
}

void bootstrap();
