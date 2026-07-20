import './otel'; // must be first — patches http/express/pg for tracing

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app/app.module';
import { AllExceptionsFilter } from './app/all-exceptions.filter';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  app.get(Logger).log(`justgo-api listening on :${config.PORT} (env ${config.NODE_ENV})`);
}

void bootstrap();
