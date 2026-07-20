import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { EventsModule } from '@justgo/events';
import { AuthModule } from '@justgo/auth';
import { ContractsModule } from '@justgo/contracts';
import { loadConfig } from '../config';
import { HealthController } from './health.controller';

const config = loadConfig();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.LOG_LEVEL,
        autoLogging: config.NODE_ENV !== 'test',
        redact: ['req.headers.authorization'],
        // NOTE: no pino transport here — worker-thread transports break in
        // the webpack bundle. Pipe through pino-pretty externally in dev:
        //   nx serve @justgo-backend/api | npx pino-pretty
      },
    }),
    EventsModule.forRoot({ redisUrl: config.REDIS_URL }),
    AuthModule.forRoot({
      jwt: config.jwksUrl
        ? { jwksUrl: config.jwksUrl, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }
        : undefined,
    }),
    ContractsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
