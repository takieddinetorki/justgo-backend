import { Module, type DynamicModule, Logger } from '@nestjs/common';
import IORedis from 'ioredis';
import { CATALOGUE_PORT, type CataloguePort } from '@justgo/contracts';
import { StubTecDocAdapter } from './infra/stub-tecdoc.adapter';
import { HttpTecDocAdapter } from './infra/http-tecdoc.adapter';
import { FetchHttpTransport } from './infra/http-transport';
import { CircuitBreaker } from './infra/circuit-breaker';
import {
  InMemoryCatalogueCache,
  RedisCatalogueCache,
  type CatalogueCache,
} from './infra/catalogue-cache';
import { ResilientCatalogue } from './infra/resilient-catalogue';

export interface TecDocModuleOptions {
  /** When set, the real HTTP adapter is used; otherwise the fixture stub. */
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
  /** Enables the Redis short-TTL cache; falls back to in-memory when unset. */
  redisUrl?: string;
  timeoutMs?: number;
}

/**
 * The TecDoc anti-corruption module (§10): the ONLY thing that talks to
 * TecDoc. Selection is env-driven (§20):
 *   - TECDOC_BASE_URL + TECDOC_API_KEY present -> real HTTP adapter, wrapped
 *     in the circuit breaker + short-TTL cache, degrading to the stub on
 *     outage so requests never block (§10.5);
 *   - otherwise -> the fixture stub (dev / CI).
 * No consumer of CATALOGUE_PORT changes either way.
 */
@Module({})
export class TecDocModule {
  static forRoot(options: TecDocModuleOptions = {}): DynamicModule {
    const opts: TecDocModuleOptions = {
      baseUrl: options.baseUrl ?? process.env['TECDOC_BASE_URL'],
      apiKey: options.apiKey ?? process.env['TECDOC_API_KEY'],
      providerId: options.providerId ?? process.env['TECDOC_PROVIDER_ID'],
      redisUrl: options.redisUrl ?? process.env['REDIS_URL'],
      timeoutMs: options.timeoutMs,
    };

    return {
      module: TecDocModule,
      global: true,
      providers: [
        StubTecDocAdapter,
        {
          provide: CATALOGUE_PORT,
          useFactory: (stub: StubTecDocAdapter): CataloguePort => {
            const logger = new Logger(TecDocModule.name);
            if (!opts.baseUrl || !opts.apiKey) {
              logger.log('TecDoc: no credentials configured — using fixture stub');
              return stub;
            }
            const transport = new FetchHttpTransport({
              baseUrl: opts.baseUrl,
              apiKey: opts.apiKey,
              providerId: opts.providerId,
              timeoutMs: opts.timeoutMs,
            });
            const primary = new HttpTecDocAdapter(transport);
            const cache: CatalogueCache = opts.redisUrl
              ? new RedisCatalogueCache(new IORedis(opts.redisUrl))
              : new InMemoryCatalogueCache();
            logger.log(
              `TecDoc: real HTTP adapter (${opts.redisUrl ? 'redis' : 'in-memory'} cache, breaker, stub fallback)`,
            );
            return new ResilientCatalogue(primary, cache, {
              breaker: new CircuitBreaker(),
              fallback: stub,
            });
          },
          inject: [StubTecDocAdapter],
        },
      ],
      exports: [CATALOGUE_PORT],
    };
  }
}
