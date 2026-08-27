/**
 * discovery PostGIS read model against the live Postgres (§19 Phase 2 DoD:
 * "nearby-suppliers query returns distance-ranked results"). Also proves the
 * event reactor builds the index. Skipped without DATABASE_URL.
 */
import { Pool } from 'pg';
import { makeEvent, InMemoryEventBus } from '@justgo/events';
import { newId, type SupplierId } from '@justgo/kernel';
import { PgDiscoveryRepository } from './pg-discovery.repository';
import { DiscoveryService } from '../application/discovery.service';
import { SupplierIndexReactor } from '../application/supplier-index.reactor';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

// central Paris reference; three suppliers at increasing distance
const PARIS = { lat: 48.8566, lng: 2.3522 };

describePg('discovery nearby', () => {
  let pool: Pool;
  let service: DiscoveryService;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new DiscoveryService(new PgDiscoveryRepository(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns suppliers ranked by real distance within the radius', async () => {
    const near = newId<SupplierId>();
    const mid = newId<SupplierId>();
    const far = newId<SupplierId>();
    await service.indexSupplier({ supplierId: near, verticalKey: 'part_store', name: 'Near', lat: 48.857, lng: 2.353, categoryKeys: ['braking'] });
    await service.indexSupplier({ supplierId: mid, verticalKey: 'part_store', name: 'Mid', lat: 48.87, lng: 2.35, categoryKeys: ['braking'] });
    await service.indexSupplier({ supplierId: far, verticalKey: 'part_store', name: 'Far', lat: 48.90, lng: 2.30, categoryKeys: ['engine'] });

    const res = await service.nearby({ ...PARIS, radiusM: 8000, verticalKeys: ['part_store'] });
    const ids = res.map((r) => r.supplierId);
    expect(ids).toContain(near);
    expect(ids).toContain(mid);
    // ranked nearest-first
    const iNear = ids.indexOf(near);
    const iMid = ids.indexOf(mid);
    expect(iNear).toBeLessThan(iMid);
    expect(res[iNear].distanceM).toBeLessThan(res[iMid].distanceM);
  });

  it('filters by category coverage', async () => {
    const brakes = newId<SupplierId>();
    const engine = newId<SupplierId>();
    await service.indexSupplier({ supplierId: brakes, verticalKey: 'part_store', name: 'Brakes', lat: 48.8567, lng: 2.3523, categoryKeys: ['braking'] });
    await service.indexSupplier({ supplierId: engine, verticalKey: 'part_store', name: 'Engine', lat: 48.8568, lng: 2.3524, categoryKeys: ['engine'] });

    const res = await service.nearby({ ...PARIS, radiusM: 5000, categoryKey: 'braking' });
    const ids = res.map((r) => r.supplierId);
    expect(ids).toContain(brakes);
    expect(ids).not.toContain(engine);
  });

  it('excludes suppliers outside the radius', async () => {
    const faraway = newId<SupplierId>();
    // Marseille, ~660km from Paris
    await service.indexSupplier({ supplierId: faraway, verticalKey: 'part_store', name: 'Marseille', lat: 43.2965, lng: 5.3698, categoryKeys: [] });
    const res = await service.nearby({ ...PARIS, radiusM: 10000 });
    expect(res.map((r) => r.supplierId)).not.toContain(faraway);
  });

  it('builds the index from suppliers.SupplierRegistered', async () => {
    const bus = new InMemoryEventBus();
    const reactor = new SupplierIndexReactor(bus, service);
    await reactor.onApplicationBootstrap();

    const supplierId = newId<SupplierId>();
    await bus.publish([
      makeEvent({
        type: 'suppliers.SupplierRegistered',
        payload: {
          supplierId,
          ownerAccountId: newId(),
          verticalKey: 'part_store',
          name: 'Event-indexed',
          lat: 48.8566,
          lng: 2.3522,
          categoryKeys: ['braking'],
        },
      }),
    ]);

    const res = await service.nearby({ ...PARIS, radiusM: 1000 });
    expect(res.map((r) => r.supplierId)).toContain(supplierId);
  });

  it('rejects out-of-range coordinates', async () => {
    await expect(service.nearby({ lat: 200, lng: 0 })).rejects.toMatchObject({ httpStatus: 400 });
  });
});
