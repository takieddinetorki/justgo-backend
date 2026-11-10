import { NotFoundError, newId, type AccountId, type ReservationId, type SupplierId, type VehicleId } from '@justgo/kernel';
import type {
  PartyDirectoryPort,
  ServiceCatalogPort,
  VehicleDirectoryPort,
} from '@justgo/contracts';
import { ReservationsService } from './reservations.service';
import type { ReservationDTO } from '../contract/dto';

/**
 * What a workshop sees when it opens a booking — and what it saw
 * before, which was a UUID with a word in front of it.
 *
 * The supplier app rendered "Client · 4ab5bb55" because the only thing
 * the API ever told it about the customer was `clientAccountId`. These
 * tests pin the two halves of the fix: the data is actually resolved,
 * and when there is nothing to resolve the answer is null rather than
 * something that looks like a name.
 */

const CLIENT = newId<AccountId>();
const SUPPLIER = newId<SupplierId>();
const OTHER_SUPPLIER = newId<SupplierId>();
const CAR = newId<VehicleId>();

function booking(over: Partial<ReservationDTO> = {}): ReservationDTO {
  return {
    id: newId<ReservationId>(),
    clientAccountId: CLIENT,
    supplierId: SUPPLIER,
    branchId: null,
    serviceTypeKey: 'brake_service',
    vehicleId: CAR,
    slotStart: '2026-11-10T23:12:00.000Z',
    slotEnd: '2026-11-11T00:12:00.000Z',
    status: 'accepted',
    note: null,
    createdAt: '2026-11-09T23:12:00.000Z',
    ...over,
  };
}

const catalog: ServiceCatalogPort = {
  getServiceType: async () => null,
  listServiceTypes: async () => [],
};

function make(opts: {
  rows?: ReservationDTO[];
  row?: ReservationDTO | null;
  parties?: PartyDirectoryPort;
  vehicles?: VehicleDirectoryPort;
}) {
  const repo = {
    listForSupplier: jest.fn(async () => opts.rows ?? []),
    byIdForSupplier: jest.fn(async () => opts.row ?? null),
  };
  const parties: PartyDirectoryPort = opts.parties ?? {
    partyFor: jest.fn(async (accountId: string) => ({
      accountId,
      name: 'Riyad Benali',
      phone: '+213555112233',
    })),
  };
  const vehicles: VehicleDirectoryPort = opts.vehicles ?? {
    vehicleFor: jest.fn(async (_owner: string, id: string) => ({
      id,
      name: null,
      brand: 'Kia',
      model: 'Picanto',
      year: 2010,
      vin: 'hjakd5682901',
      plate: null,
      mileageKm: 100,
    })),
  };
  const service = new ReservationsService(
    repo as never,
    catalog,
    parties,
    vehicles,
    { now: () => new Date('2026-11-10T00:00:00.000Z') },
  );
  return { service, repo, parties, vehicles };
}

describe('a booking as the supplier sees it', () => {
  it('names the customer and the car instead of handing back ids', async () => {
    const row = booking();
    const { service } = make({ row });

    const got = await service.getForSupplier(SUPPLIER, row.id);

    expect(got.customer?.name).toBe('Riyad Benali');
    expect(got.customer?.phone).toBe('+213555112233');
    expect(got.vehicle?.brand).toBe('Kia');
    expect(got.vehicle?.vin).toBe('hjakd5682901');
    // The ids are still there; they are simply no longer all there is.
    expect(got.clientAccountId).toBe(CLIENT);
  });

  /*
    THE BUG ITSELF. Most accounts on this deployment have no name,
    because nothing in signup ever asked for one. The honest answer is
    null — the app renders that as "unknown". Returning anything built
    out of the account id is how "Client · 4ab5bb55" reached a screen in
    the first place, and doing it server-side would only make it harder
    to see.
  */
  it('says null when the account has no name, and never invents one', async () => {
    const row = booking();
    const { service } = make({
      row,
      parties: { partyFor: async (accountId) => ({ accountId, name: null, phone: null }) },
    });

    const got = await service.getForSupplier(SUPPLIER, row.id);

    expect(got.customer).not.toBeNull();
    expect(got.customer?.name).toBeNull();
    expect(got.customer?.phone).toBeNull();
    // The id is carried as an id, under its own name, and nothing is
    // dressed up out of it.
    expect(got.customer?.accountId).toBe(String(CLIENT));
    expect(got.customer?.name ?? '').not.toContain(String(CLIENT).slice(0, 8));
  });

  /*
    The vehicle read is owner-scoped on the CLIENT named on the booking,
    never on the supplier asking. That is what stops this becoming a
    lookup of any car by id: the only ones a workshop can resolve are
    the ones booked in with them.
  */
  it('resolves the car as the client who owns it, not as the supplier', async () => {
    const row = booking();
    const vehicleFor = jest.fn(async () => null);
    const { service } = make({ row, vehicles: { vehicleFor } });

    await service.getForSupplier(SUPPLIER, row.id);

    expect(vehicleFor).toHaveBeenCalledWith(String(CLIENT), String(CAR));
  });

  it('asks the directories once per distinct customer and car', async () => {
    // A workshop's day: the same regular, the same car, four times.
    const rows = [booking(), booking(), booking(), booking()];
    const partyFor = jest.fn(async (accountId: string) => ({ accountId, name: 'Riyad', phone: null }));
    const vehicleFor = jest.fn(async (_o: string, id: string) => ({
      id, name: null, brand: 'Kia', model: 'Picanto', year: 2010, vin: null, plate: null, mileageKm: null,
    }));
    const { service } = make({ rows, parties: { partyFor }, vehicles: { vehicleFor } });

    const items = await service.listForSupplier(SUPPLIER);

    expect(items).toHaveLength(4);
    expect(items.every((i) => i.customer?.name === 'Riyad')).toBe(true);
    expect(partyFor).toHaveBeenCalledTimes(1);
    expect(vehicleFor).toHaveBeenCalledTimes(1);
  });

  /*
    A directory being unreachable must cost a label, not the calendar.
    A workshop that cannot see today's bookings because identity is down
    is a worse outage than a row with no name on it.
  */
  it('still returns the calendar when a directory throws', async () => {
    const rows = [booking()];
    const { service } = make({
      rows,
      parties: { partyFor: async () => { throw new Error('identity unreachable'); } },
      vehicles: { vehicleFor: async () => { throw new Error('vehicles unreachable'); } },
    });

    const items = await service.listForSupplier(SUPPLIER);

    expect(items).toHaveLength(1);
    expect(items[0].customer).toBeNull();
    expect(items[0].vehicle).toBeNull();
    expect(items[0].status).toBe('accepted');
  });

  it('leaves the vehicle null for a service that needs no car', async () => {
    const row = booking({ vehicleId: null });
    const vehicleFor = jest.fn(async () => null);
    const { service } = make({ row, vehicles: { vehicleFor } });

    const got = await service.getForSupplier(SUPPLIER, row.id);

    expect(got.vehicle).toBeNull();
    expect(vehicleFor).not.toHaveBeenCalled();
  });

  /*
    Someone else's booking is NOT FOUND, not forbidden. A 403 would
    confirm that the id exists, which is exactly what a supplier
    scanning ids they were never given would be fishing for.
  */
  it('does not confirm the existence of another supplier booking', async () => {
    const { service, repo } = make({ row: null });

    await expect(service.getForSupplier(OTHER_SUPPLIER, newId<ReservationId>())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(repo.byIdForSupplier).toHaveBeenCalled();
  });
});
