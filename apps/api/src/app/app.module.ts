import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { EventsModule } from '@justgo/events';
import { AuthModule } from '@justgo/auth';
import { ContractsModule, SUPPLIER_TARGETING_PORT } from '@justgo/contracts';
import { IdentityModule } from '@justgo/identity';
import { SuppliersModule } from '@justgo/suppliers';
import { RequestsModule } from '@justgo/requests';
import { OrdersModule } from '@justgo/orders';
import { loadConfig } from '../config';
import { HealthController } from './health.controller';
import { ENABLED_VERTICALS } from './verticals';
import { SupplierTargetingAdapter } from './supplier-targeting.adapter';

const config = loadConfig();

/**
 * Composition root. Bounded contexts load only when a database is
 * configured, so the skeleton still boots (health only) in bare
 * environments.
 */
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
    ...(config.DATABASE_URL
      ? [IdentityModule, SuppliersModule, RequestsModule, OrdersModule]
      : []),
  ],
  controllers: [HealthController],
  providers: [
    // binds the requests module's fan-out seam to the suppliers module
    ...(config.DATABASE_URL
      ? [
          SupplierTargetingAdapter,
          { provide: SUPPLIER_TARGETING_PORT, useExisting: SupplierTargetingAdapter },
        ]
      : []),
  ],
})
export class AppModule {}
