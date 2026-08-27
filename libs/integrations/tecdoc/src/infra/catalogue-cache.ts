import type Redis from 'ioredis';

/**
 * Short-TTL cache for individual TecDoc lookups (§10.4). We cache single
 * query results with minutes-scale TTLs — NEVER a bulk/full copy of the
 * database (that would breach the TecAlliance licence). When unsure, cache
 * less: TTLs are deliberately conservative and configurable.
 */
export interface CatalogueCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

/** Redis-backed cache, namespaced so it is trivially purgeable. */
export class RedisCatalogueCache implements CatalogueCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'tecdoc:',
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(this.prefix + key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', ttlSeconds);
  }
}

/** In-memory cache for tests and single-process dev (honours TTL). */
export class InMemoryCatalogueCache implements CatalogueCache {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
}
