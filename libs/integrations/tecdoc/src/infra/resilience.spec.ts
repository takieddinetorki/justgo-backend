import type { CataloguePort, ArticleRef } from '@justgo/contracts';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { FetchHttpTransport, TecDocHttpError } from './http-transport';
import { HttpTecDocAdapter } from './http-tecdoc.adapter';
import { InMemoryCatalogueCache } from './catalogue-cache';
import { ResilientCatalogue } from './resilient-catalogue';

describe('CircuitBreaker (§10.5)', () => {
  it('opens after the failure threshold and short-circuits', async () => {
    const clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => clock });
    const boom = () => Promise.reject(new Error('down'));

    for (let i = 0; i < 3; i += 1) await expect(breaker.run(boom)).rejects.toThrow('down');
    expect(breaker.current()).toBe('open');
    // now short-circuits without calling through
    await expect(breaker.run(boom)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('half-opens after cooldown and closes on a successful probe', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => clock });
    await expect(breaker.run(() => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(breaker.current()).toBe('open');
    clock += 600; // past cooldown
    await expect(breaker.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.current()).toBe('closed');
  });
});

describe('FetchHttpTransport', () => {
  it('retries 5xx then succeeds, and does not retry 4xx', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 2) return new Response('err', { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = new FetchHttpTransport({
      baseUrl: 'https://tecdoc.example/api',
      apiKey: 'k',
      fetchImpl,
      sleep: async () => undefined,
      random: () => 0,
    });
    await expect(t.post({ path: 'x', body: {} })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    calls = 0;
    const four = (async () => {
      calls += 1;
      return new Response('nope', { status: 400 });
    }) as unknown as typeof fetch;
    const t2 = new FetchHttpTransport({ baseUrl: 'https://x/api', apiKey: 'k', fetchImpl: four, sleep: async () => undefined });
    await expect(t2.post({ path: 'x', body: {} })).rejects.toBeInstanceOf(TecDocHttpError);
    expect(calls).toBe(1); // no retry on 4xx
  });
});

describe('HttpTecDocAdapter mapping', () => {
  it('maps TecDoc vehicle + article wire shapes to the domain contract', async () => {
    const transport = {
      post: async <T>({ path }: { path: string }): Promise<T> => {
        if (path === 'vehicles/search') {
          return {
            data: [
              {
                linkageTargetId: 12345,
                manufacturerId: 1,
                modelId: 2,
                manufacturerName: 'Renault',
                modelName: 'Clio',
                typeName: '1.5 dCi',
                yearOfConstructionFrom: '2012-01',
                yearOfConstructionTo: null,
                powerKw: 66,
                fuelType: 'Diesel',
              },
            ],
          } as T;
        }
        return {
          data: [
            {
              articleId: 999,
              articleNumber: 'BRK-1',
              mfrName: 'Brembo',
              genericArticleDescription: 'Brake pad set',
              assemblyGroupNodeId: 100,
            },
          ],
        } as T;
      },
    };
    const adapter = new HttpTecDocAdapter(transport);

    const vehicles = await adapter.resolveVehicle({ manufacturer: 'Renault', model: 'Clio' });
    expect(vehicles[0]).toMatchObject({ kType: 12345, manufacturer: 'Renault', fromYear: 2012, toYear: null, powerKw: 66 });

    const articles = await adapter.searchArticles({ kType: 12345 });
    expect(articles[0]).toEqual({
      articleId: 999,
      name: 'Brake pad set',
      brand: 'Brembo',
      reference: 'BRK-1',
      assemblyGroupId: 100,
    });
  });
});

describe('ResilientCatalogue (§10.4/§10.5)', () => {
  const article: ArticleRef = { articleId: 1, name: 'Pad', brand: 'B', reference: 'R', assemblyGroupId: 1 };

  const portReturning = (fn: () => Promise<ArticleRef[]>): CataloguePort => ({
    resolveVehicle: async () => [],
    assemblyGroups: async () => [],
    searchArticles: fn,
    articleDetail: async () => null,
    crossReferences: async () => [],
  });

  it('caches a hit so the primary is called once', async () => {
    let calls = 0;
    const primary = portReturning(async () => {
      calls += 1;
      return [article];
    });
    const rc = new ResilientCatalogue(primary, new InMemoryCatalogueCache());
    await rc.searchArticles({ kType: 1 });
    await rc.searchArticles({ kType: 1 });
    expect(calls).toBe(1);
  });

  it('degrades to the fallback adapter when the primary keeps failing', async () => {
    const primary = portReturning(async () => {
      throw new Error('TecDoc down');
    });
    const fallback = portReturning(async () => [{ ...article, brand: 'FALLBACK' }]);
    const rc = new ResilientCatalogue(primary, new InMemoryCatalogueCache(), {
      breaker: new CircuitBreaker({ failureThreshold: 1 }),
      fallback,
    });
    const res = await rc.searchArticles({ kType: 7 });
    expect(res[0].brand).toBe('FALLBACK'); // request never blocked
  });

  it('returns empty (never throws) when primary is down and no fallback', async () => {
    const primary = portReturning(async () => {
      throw new Error('down');
    });
    const rc = new ResilientCatalogue(primary, new InMemoryCatalogueCache());
    await expect(rc.searchArticles({ kType: 1 })).resolves.toEqual([]);
  });
});
