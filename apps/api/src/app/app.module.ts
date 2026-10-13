import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { EventsModule } from '@justgo/events';
import { AuthModule } from '@justgo/auth';
import { ContractsModule } from '@justgo/contracts';
import { IdentityModule } from '@justgo/identity';
import { SuppliersModule } from '@justgo/suppliers';
import { RequestsModule } from '@justgo/requests';
import { OrdersModule } from '@justgo/orders';
import { VehiclesModule } from '@justgo/vehicles';
import { DiscoveryModule } from '@justgo/discovery';
import { MediaModule } from '@justgo/media';
import { RealtimeModule } from '@justgo/realtime';
import { NotificationsModule } from '@justgo/notifications';
import { TecDocModule } from '@justgo/tecdoc';
import { CatalogueModule } from '@justgo/catalogue';
import { ReservationsModule } from '@justgo/reservations';
import { MarketplaceModule } from '@justgo/marketplace';
import { AssistanceModule } from '@justgo/assistance';
import { MessagingModule } from '@justgo/messaging';
import { DocumentsModule } from '@justgo/documents';
import { SocialModule } from '@justgo/social';
import { ReclamationsModule } from '@justgo/reclamations';
import { DriversModule } from '@justgo/drivers';
import { loadConfig } from '../config';
import { HealthController } from './health.controller';
import { DocsController } from './docs.controller';
import { ENABLED_VERTICALS } from './verticals';
import { TargetingModule } from './targeting.module';
import { SchedulerRunner } from './scheduler.runner';
import { callerTracker } from './throttle.guard';

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
    /*
      Rate limiting (see throttle.guard.ts for how a caller is identified).

      THE DEFAULT IS SET BY WHAT THE SHIPPED APP ALREADY DOES, not by taste.
      It polls instead of using Realtime — the integrator test traffic shows
      2 666 calls to GET /v1/orders alone — so the baseline has to sit well
      above a polling client or the limit becomes an outage. Tighter limits
      are applied per route, where either enumeration is the risk (public
      reads) or spam costs other users something (content creation).

      In-memory storage, deliberately: one API container runs today, and a
      Redis-backed store would mean a third-party package for a control that
      is better off with no new dependencies. IF A SECOND API REPLICA IS EVER
      ADDED, every limit here silently doubles — move the storage to Redis in
      the same change.
    */
    ThrottlerModule.forRoot({
      /*
        ONE throttler, overridden per route with @Throttle({ default: … }).

        Not three named ones. The guard loops over EVERY named throttler for
        every request and falls back to that throttler root limit when a
        route does not override it — so adding a `strict: 20` alongside a
        `default: 600` would cap the entire API at 20 requests a minute,
        including the polling the app already does. Checked against the
        guard source rather than assumed.
      */
      throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }],
      // Per caller, not per address — see throttle.guard.ts. Passed as an
      // option rather than overridden in a subclass, because subclassing
      // ThrottlerGuard crash-loops the bundle (same file explains why).
      getTracker: (req) => callerTracker(req as never),
      /*
        The probe itself must never be throttled: a load balancer or an
        uptime check hits it constantly, and a 429 there reads as the service
        being down.
      */
      skipIf: (ctx) => {
        const path: string = ctx.switchToHttp().getRequest()?.path ?? '';
        return path === '/v1/health' || path.startsWith('/v1/docs');
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
    TecDocModule.forRoot({
      baseUrl: config.TECDOC_BASE_URL,
      apiKey: config.TECDOC_API_KEY,
      providerId: config.TECDOC_PROVIDER_ID,
      redisUrl: config.REDIS_URL,
    }),
    MediaModule.forRoot({
      supabaseUrl: config.SUPABASE_URL,
      serviceKey: config.SUPABASE_SERVICE_KEY,
    }),
    RealtimeModule.forRoot({
      supabaseUrl: config.SUPABASE_URL,
      apiKey: config.SUPABASE_SERVICE_KEY,
    }),
    ...(config.DATABASE_URL
      ? [TargetingModule.forRoot(), IdentityModule, SuppliersModule, RequestsModule, OrdersModule, NotificationsModule, VehiclesModule, DiscoveryModule, CatalogueModule.forRoot(), ReservationsModule, MarketplaceModule, AssistanceModule, MessagingModule, DocumentsModule.forRoot(), SocialModule, ReclamationsModule, DriversModule]
      : []),
  ],
  controllers: [HealthController, DocsController],
  providers: [
    /*
      The fan-out seam is NOT provided here any more. A provider in this
      array is invisible to RequestsModule, where FanOutReactor lives —
      which is exactly how every part request came to be dropped. It is
      a global module now; see targeting.module.ts.
    */
    ...(config.DATABASE_URL ? [SchedulerRunner] : []),
    /*
      Registered here rather than inside AuthModule so the composition root
      owns it, like every other cross-cutting concern. Order against
      RbacGuard does not matter: the tracker reads the raw Authorization
      header, never the AuthContext that guard attaches.
    */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
