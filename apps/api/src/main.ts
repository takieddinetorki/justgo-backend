import './otel'; // must be first — patches http/express/pg for tracing

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app/app.module';
import { AllExceptionsFilter } from './app/all-exceptions.filter';
import { loadConfig } from './config';
import { buildOpenApiDocument } from './openapi';
import { setOpenApiDocument } from './docs-document';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  setOpenApiDocument(buildOpenApiDocument(app));
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  app.get(Logger).log(`justgo-api on :${config.PORT} (env ${config.NODE_ENV}) — docs at /v1/docs`);
}

void bootstrap();
