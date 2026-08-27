import { Logger } from '@nestjs/common';
import type {
  ArticleDetail,
  ArticleQuery,
  ArticleRef,
  AssemblyGroup,
  CataloguePort,
  VehicleQuery,
  VehicleTypeRef,
} from '@justgo/contracts';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import type { CatalogueCache } from './catalogue-cache';

export interface ResilientCatalogueOptions {
  /** per-method cache TTLs in seconds (§10.4 — kept short on purpose). */
  ttl?: Partial<Record<keyof CataloguePort, number>>;
  breaker?: CircuitBreaker;
  /**
   * Served when the primary is down AND nothing is cached, so a TecDoc
   * outage never blocks a request (§10.5). The stub adapter is a natural
   * fallback; omit to degrade to empty results.
   */
  fallback?: CataloguePort;
}

const DEFAULT_TTL: Record<keyof CataloguePort, number> = {
  resolveVehicle: 3600,
  assemblyGroups: 3600,
  searchArticles: 600,
  articleDetail: 1800,
  crossReferences: 1800,
};

/**
 * Wraps a CataloguePort (the real HTTP adapter) with a short-TTL cache and a
 * circuit breaker, degrading gracefully (§10.4/§10.5):
 *   1. serve a fresh cache hit;
 *   2. else call the primary through the breaker and cache the result;
 *   3. on breaker-open or failure, serve a stale-tolerant cache entry, then
 *      the fallback adapter, then an empty result — never throw upward.
 */
export class ResilientCatalogue implements CataloguePort {
  private readonly logger = new Logger(ResilientCatalogue.name);
  private readonly breaker: CircuitBreaker;
  private readonly ttl: Record<keyof CataloguePort, number>;

  constructor(
    private readonly primary: CataloguePort,
    private readonly cache: CatalogueCache,
    private readonly opts: ResilientCatalogueOptions = {},
  ) {
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.ttl = { ...DEFAULT_TTL, ...(opts.ttl ?? {}) };
  }

  resolveVehicle(query: VehicleQuery): Promise<VehicleTypeRef[]> {
    return this.run('resolveVehicle', query, [], (p) => p.resolveVehicle(query));
  }
  assemblyGroups(kType: number): Promise<AssemblyGroup[]> {
    return this.run('assemblyGroups', kType, [], (p) => p.assemblyGroups(kType));
  }
  searchArticles(query: ArticleQuery): Promise<ArticleRef[]> {
    return this.run('searchArticles', query, [], (p) => p.searchArticles(query));
  }
  articleDetail(articleId: number): Promise<ArticleDetail | null> {
    return this.run('articleDetail', articleId, null, (p) => p.articleDetail(articleId));
  }
  crossReferences(articleOrOe: string | number): Promise<ArticleRef[]> {
    return this.run('crossReferences', articleOrOe, [], (p) => p.crossReferences(articleOrOe));
  }

  private key(method: keyof CataloguePort, arg: unknown): string {
    return `${method}:${JSON.stringify(arg)}`;
  }

  private async run<T>(
    method: keyof CataloguePort,
    arg: unknown,
    empty: T,
    call: (p: CataloguePort) => Promise<T>,
  ): Promise<T> {
    const key = this.key(method, arg);
    const cached = await this.cache.get<T>(key);
    if (cached !== null) return cached;

    try {
      const fresh = await this.breaker.run(() => call(this.primary));
      await this.cache.set(key, fresh, this.ttl[method]);
      return fresh;
    } catch (error) {
      const reason = error instanceof CircuitOpenError ? 'circuit open' : (error as Error).message;
      this.logger.warn(`TecDoc ${method} degraded (${reason}) — falling back`);
      if (this.opts.fallback) {
        try {
          return await call(this.opts.fallback);
        } catch (fallbackError) {
          this.logger.error(`TecDoc fallback ${method} also failed: ${(fallbackError as Error).message}`);
        }
      }
      return empty;
    }
  }
}
