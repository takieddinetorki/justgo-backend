import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

/**
 * Headless worker process: outbox relay + BullMQ consumers (§12).
 * No HTTP surface — runs as a Nest application context.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  Logger.log('justgo-workers running');
}

void bootstrap();
