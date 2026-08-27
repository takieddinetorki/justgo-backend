/**
 * vehicles garage against the live self-hosted Postgres (§19 Phase 2 DoD:
 * "add a vehicle -> resolves to KType"). A fake CataloguePort stands in for
 * TecDoc so the test is hermetic. Skipped without DATABASE_URL.
 */
import { Pool } from 'pg';
import { newId, NotFoundError, type AccountId } from '@justgo/kernel';
import type { CataloguePort, VehicleTypeRef } from '@justgo/contracts';
import { PgVehiclesRepository } from './pg-vehicles.repository';
import { VehiclesService } from '../application/vehicles.service';
import { VEHICLE_ADDED, MAINTENANCE_DUE } from '../contract/events';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

const kTypeCatalogue: CataloguePort = {
  resolveVehicle: async (q): Promise<VehicleTypeRef[]> =>
    q.manufacturer?.toLowerCase() === 'renault'
      ? [
          {
            kType: 12345,
            manufacturerId: 11,
            modelId: 22,
            manufacturer: 'Renault',
            model: 'Clio',
            typeName: '1.5 dCi',
            fromYear: 2012,
            toYear: null,
            powerKw: 66,
            fuel: 'Diesel',
          },
        ]
      : [],
  assemblyGroups: async () => [],
  searchArticles: async () => [],
  articleDetail: async () => null,
  crossReferences: async () => [],
};

describePg('vehicles garage', () => {
  let pool: Pool;
  let repo: PgVehiclesRepository;
  let service: VehiclesService;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PgVehiclesRepository(pool);
    service = new VehiclesService(repo, kTypeCatalogue);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds a vehicle, resolves its KType, and emits VehicleAdded', async () => {
    const owner = newId<AccountId>();
    const v = await service.add(owner, { brand: 'Renault', model: 'Clio', year: 2015 });
    expect(v.tecdocVehicleTypeId).toBe(12345);
    expect(v.tecdocManufacturerId).toBe(11);
    expect(v.healthStatus).toBe('good');

    const events = await pool.query(`select type from vehicles.outbox where aggregate_id = $1`, [v.id]);
    expect(events.rows.map((r) => r.type)).toEqual([VEHICLE_ADDED]);
  });

  it('adds a vehicle with no TecDoc match without failing', async () => {
    const owner = newId<AccountId>();
    const v = await service.add(owner, { brand: 'Spaceship', model: 'X' });
    expect(v.tecdocVehicleTypeId).toBeNull();
  });

  it('lists, updates mileage, and scopes to the owner', async () => {
    const owner = newId<AccountId>();
    const stranger = newId<AccountId>();
    const v = await service.add(owner, { name: 'Daily', brand: 'Renault' });
    expect((await service.list(owner)).map((x) => x.id)).toContain(v.id);

    const updated = await service.setMileage(owner, v.id, 90500);
    expect(updated.mileageKm).toBe(90500);

    await expect(service.get(stranger, v.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('sweeps a due maintenance task and emits MaintenanceDue', async () => {
    const owner = newId<AccountId>();
    const v = await service.add(owner, { brand: 'Renault' });
    await service.setMileage(owner, v.id, 90500);
    const task = await service.addMaintenanceTask(owner, v.id, { title: 'Timing belt', dueAtKm: 90000 });

    const swept = await service.sweepDueMaintenance(new Date());
    expect(swept).toBeGreaterThanOrEqual(1);

    const tasks = await service.listMaintenance(owner, v.id);
    expect(tasks.find((t) => t.id === task.id)?.status).toBe('due');

    const events = await pool.query(
      `select type from vehicles.outbox where type = $1 and aggregate_id = $2`,
      [MAINTENANCE_DUE, v.id],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes a vehicle and cascades its children', async () => {
    const owner = newId<AccountId>();
    const v = await service.add(owner, { brand: 'Renault' });
    await service.addMaintenanceTask(owner, v.id, { title: 'Oil' });
    await service.remove(owner, v.id);
    await expect(service.get(owner, v.id)).rejects.toBeInstanceOf(NotFoundError);
    const tasks = await pool.query(`select id from vehicles.maintenance_tasks where vehicle_id = $1`, [
      v.id as unknown as string,
    ]);
    expect(tasks.rows).toHaveLength(0);
  });
});
