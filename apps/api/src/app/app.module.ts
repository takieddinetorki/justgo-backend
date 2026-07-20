import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { EventsModule } from '@justgo/events';
import { AuthModule } from '@justgo/auth';
import { ContractsModule } from '@justgo/contracts';
import { IdentityModule } from '@justgo/identity';
import { SuppliersModule } from '@justgo/suppliers';
import { loadConfig } from '../config';
import { HealthController } from './health.controller';
import { ENABLED_VERTICALS } from './verticals';

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
      jwt:
        config.JWT_SECRET || config.jwksUrl
          ? {
              secret: config.JWT_SECRET,
              jwksUrl: config.jwksUrl,
              issuer: config.JWT_ISSUER,
              audience: config.JWT_AUDIENCE,
            }
          : undefined,
    }),
    ContractsModule.forRoot(ENABLED_VERTICALS),
    // bounded contexts (only when a database is configured — health stays up
    // without one so the skeleton keeps booting in bare environments)
    ...(config.DATABASE_URL ? [IdentityModule, SuppliersModule] : []),
  ],
  controllers: [HealthController],
})
export class AppModule {}
