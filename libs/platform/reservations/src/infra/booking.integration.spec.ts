/**
 * Phase 3 DoD (§19): a booking flows pending → accepted, and double-booking
 * the same slot is impossible. Skipped without DATABASE_URL.
 */
import { Pool } from 'pg';
import {
  newId,
  type AccountId,
  type ReservationId,
  type SupplierId,
  type VehicleId,
} from '@justgo/kernel';
import type { ServiceCatalogPort, ServiceTypeDTO } from '@justgo/contracts';
import { PgReservationsRepository } from './pg-reservations.repository';
import { ReservationsService } from '../application/reservations.service';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

const oilChange: ServiceTypeDTO = {
  key: 'oil_change',
  verticalKey: 'workshop',
  labelI18n: { en: 'Oil change', es: 'Cambio de aceite', fr: 'Vidange' },
  pricingModel: 'fixed',
  requiresCalendar: true,
  requiresVehicle: true,
  active: true,
};

const catalog: ServiceCatalogPort = {
  getServiceType: async (key) => (key === 'oil_change' ? oilChange : null),
  listServiceTypes: async () => [oilChange],
};

const soon = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString();

describePg('booking flow', () => {
  let pool: Pool;
  let service: ReservationsService;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new ReservationsService(new PgReservationsRepository(pool), catalog, { now: () => new Date() });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('flows pending → accepted', async () => {
    const client = newId<AccountId>();
    const supplier = newId<SupplierId>();
    const r = await service.request(client, {
      supplierId: supplier,
      serviceTypeKey: 'oil_change',
      vehicleId: newId<VehicleId>(),
      slotStart: soon(60),
      slotEnd: soon(120),
    });
    expect(r.status).toBe('pending');

    const accepted = await service.accept(supplier, r.id);
    expect(accepted.status).toBe('accepted');

    const done = await service.complete(supplier, r.id);
    expect(done.status).toBe('completed');
  });

  it('prevents double-booking the same slot (§8.3)', async () => {
    const supplier = newId<SupplierId>();
    const slotStart = soon(300);
    const slotEnd = soon(360);
    const base = { supplierId: supplier, serviceTypeKey: 'oil_change', vehicleId: newId<VehicleId>(), slotStart, slotEnd };

    await service.request(newId<AccountId>(), base);
    await expect(service.request(newId<AccountId>(), base)).rejects.toMatchObject({
      code: 'SLOT_TAKEN',
      httpStatus: 409,
    });
  });

  it('frees the slot when the first booking is rejected', async () => {
    const supplier = newId<SupplierId>();
    const slotStart = soon(600);
    const slotEnd = soon(660);
    const base = { supplierId: supplier, serviceTypeKey: 'oil_change', vehicleId: newId<VehicleId>(), slotStart, slotEnd };

    const first = await service.request(newId<AccountId>(), base);
    await service.reject(supplier, first.id, 'unavailable');
    // slot is now free — a new booking succeeds
    const second = await service.request(newId<AccountId>(), base);
    expect(second.status).toBe('pending');
  });

  it('requires a vehicle for a vehicle-bound service', async () => {
    await expect(
      service.request(newId<AccountId>(), {
        supplierId: newId<SupplierId>(),
        serviceTypeKey: 'oil_change',
        slotStart: soon(60),
        slotEnd: soon(120),
      }),
    ).rejects.toMatchObject({ code: 'VEHICLE_REQUIRED' });
  });

  it('rejects an unknown service type and past slots', async () => {
    const client = newId<AccountId>();
    await expect(
      service.request(client, { supplierId: newId<SupplierId>(), serviceTypeKey: 'nope', slotStart: soon(60), slotEnd: soon(120) }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_SERVICE_TYPE' });
    await expect(
      service.request(client, { supplierId: newId<SupplierId>(), serviceTypeKey: 'oil_change', vehicleId: newId<VehicleId>(), slotStart: soon(-60), slotEnd: soon(-30) }),
    ).rejects.toMatchObject({ code: 'SLOT_IN_PAST' });
  });

  it('supplier can only act on its own reservations', async () => {
    const r = await service.request(newId<AccountId>(), {
      supplierId: newId<SupplierId>(),
      serviceTypeKey: 'oil_change',
      vehicleId: newId<VehicleId>(),
      slotStart: soon(900),
      slotEnd: soon(960),
    });
    await expect(service.accept(newId<SupplierId>(), r.id as ReservationId)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });
});
