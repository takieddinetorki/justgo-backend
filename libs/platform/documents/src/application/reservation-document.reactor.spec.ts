import { ReservationDocumentReactor } from './reservation-document.reactor';
import type { DomainEvent } from '@justgo/events';

/**
 * What the confirmation SAYS.
 *
 * It used to say this, in full:
 *
 *   Réservation  4d2fa9fb-e168-4f54-9030-2bd10b973a0c
 *   Statut       Confirmée
 *   Prestataire  9dcd8e25-ac91-4032-93d6-a4d702f1dead
 *   Client       4ab5bb55-1119-4714-ab19-048aa347e8c6
 *
 * Four primary keys and a status. Unreadable on paper, useless to a
 * workshop, and — because the frozen payload is also what verification
 * reads back — it left a scan with nothing to compare against the page.
 */

const EVENT = {
  type: 'reservations.ReservationStatusChanged',
  payload: {
    reservationId: '4d2fa9fb-e168-4f54-9030-2bd10b973a0c',
    clientAccountId: '4ab5bb55-1119-4714-ab19-048aa347e8c6',
    supplierId: '9dcd8e25-ac91-4032-93d6-a4d702f1dead',
    from: 'pending',
    to: 'accepted',
    serviceTypeKey: 'brake_service',
    slotStart: '2026-11-10T23:12:00.000Z',
    slotEnd: '2026-11-11T00:12:00.000Z',
    vehicleId: '0be1e21d-a7f8-4890-8104-b3e12ea21a0c',
  },
} as unknown as DomainEvent;

function build(over: Partial<Record<string, unknown>> = {}) {
  const issue = jest.fn(async (input: { payload: Record<string, unknown> }) => ({
    number: 'RES-2026-000014',
    payload: input.payload,
  }));
  const bus = { subscribe: jest.fn(), publish: jest.fn() };
  const parties = {
    partyFor: async () => ({ accountId: 'x', name: 'Riyad Benali', phone: '+213555112233' }),
  };
  const sellers = { sellerFor: async () => ({ legalName: 'Garage Walid' }) };
  const services = {
    getServiceType: async () => ({ key: 'brake_service', labelI18n: { fr: 'Freinage', en: 'Brakes' } }),
  };
  const vehicles = {
    vehicleFor: async () => ({
      id: '0be1e21d-a7f8-4890-8104-b3e12ea21a0c',
      brand: 'Kia',
      model: 'Picanto',
      year: 2010,
      vin: 'hjakd5682901',
      plate: '16-12345-119',
      mileageKm: 100,
    }),
  };
  const reactor = new ReservationDocumentReactor(
    bus as never,
    { issue } as never,
    (over['parties'] ?? parties) as never,
    (over['sellers'] ?? sellers) as never,
    (over['services'] ?? services) as never,
    (over['vehicles'] ?? vehicles) as never,
  );
  return { reactor, issue };
}

describe('the reservation confirmation', () => {
  it('prints people and appointments, not primary keys', async () => {
    const { reactor, issue } = build();

    await reactor.handle(EVENT);

    const payload = issue.mock.calls[0][0].payload;
    expect(payload['Client']).toBe('Riyad Benali');
    expect(payload['Prestataire']).toBe('Garage Walid');
    expect(payload['Prestation']).toBe('Freinage');
    expect(payload['Rendez-vous']).toBe('10/11/2026 23:12 - 00:12');
    expect(payload['Véhicule']).toBe('Kia Picanto 2010');
    expect(payload['VIN']).toBe('hjakd5682901');
    // The reference stays: it is what support asks for.
    expect(payload['Réservation']).toBe('4d2fa9fb-e168-4f54-9030-2bd10b973a0c');
  });

  /*
    A directory that cannot answer costs a label, never the document. A
    customer with no confirmation at all is worse off than one holding a
    confirmation that names them by id.
  */
  it('falls back to the id rather than failing to issue', async () => {
    const { reactor, issue } = build({
      parties: { partyFor: async () => { throw new Error('identity down'); } },
      sellers: { sellerFor: async () => null },
      services: { getServiceType: async () => null },
      vehicles: { vehicleFor: async () => null },
    });

    await reactor.handle(EVENT);

    const payload = issue.mock.calls[0][0].payload;
    expect(payload['Client']).toBe('4ab5bb55-1119-4714-ab19-048aa347e8c6');
    expect(payload['Prestataire']).toBe('9dcd8e25-ac91-4032-93d6-a4d702f1dead');
    // The service key is still readable to a mechanic; the slot is unaffected.
    expect(payload['Prestation']).toBe('brake_service');
    expect(payload['Rendez-vous']).toBe('10/11/2026 23:12 - 00:12');
    expect(payload['Véhicule']).toBeUndefined();
  });

  it('issues nothing for a status that is not acceptance', async () => {
    const { reactor, issue } = build();

    await reactor.handle({
      ...EVENT,
      payload: { ...(EVENT as unknown as { payload: object }).payload, to: 'rejected' },
    } as unknown as DomainEvent);

    expect(issue).not.toHaveBeenCalled();
  });

  /*
    Events already in the outbox when this shipped carry only the ids.
    They must still produce a confirmation, not throw on a missing slot.
  */
  it('handles an event emitted before the booking travelled with it', async () => {
    const { reactor, issue } = build();

    await reactor.handle({
      type: 'reservations.ReservationStatusChanged',
      payload: {
        reservationId: '4d2fa9fb-e168-4f54-9030-2bd10b973a0c',
        clientAccountId: '4ab5bb55-1119-4714-ab19-048aa347e8c6',
        supplierId: '9dcd8e25-ac91-4032-93d6-a4d702f1dead',
        from: 'pending',
        to: 'accepted',
      },
    } as unknown as DomainEvent);

    const payload = issue.mock.calls[0][0].payload;
    expect(payload['Client']).toBe('Riyad Benali');
    expect(payload['Prestation']).toBeUndefined();
    expect(payload['Rendez-vous']).toBeUndefined();
  });
});
