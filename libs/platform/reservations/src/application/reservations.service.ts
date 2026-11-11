import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessRuleError,
  CLOCK,
  NotFoundError,
  ValidationError,
  type AccountId,
  type Clock,
  type ReservationId,
  type SupplierId,
} from '@justgo/kernel';
import {
  PARTY_DIRECTORY_PORT,
  SERVICE_CATALOG_PORT,
  VEHICLE_DIRECTORY_PORT,
  type PartyDTO,
  type PartyDirectoryPort,
  type ServiceCatalogPort,
  type VehicleDirectoryPort,
  type VehicleSummaryDTO,
} from '@justgo/contracts';
import type { ReservationsPort } from '../contract/reservations.port';
import type {
  ChargeDTO,
  CreateReservationDTO,
  RescheduleDTO,
  ReservationDTO,
  SupplierReservationDTO,
} from '../contract/dto';
import { PgReservationsRepository } from '../infra/pg-reservations.repository';

/**
 * Money, checked before it reaches a facture.
 *
 * Integer minor units only - no floats anywhere near a total (17.4) - and
 * a three-letter currency, because the facture renderer prints whatever
 * it is handed and a blank or a 'dzd ' would go out on a tax document.
 *
 * Zero is ALLOWED and means exactly that: a job done for nothing. It is
 * recorded so the calendar can show it was settled, and it issues no
 * facture, because a facture for 0,00 is not a document anyone needs.
 */
function validCharge(charge: ChargeDTO | undefined): ChargeDTO | undefined {
  if (charge === undefined) return undefined;
  if (!Number.isSafeInteger(charge.amountMinor) || charge.amountMinor < 0) {
    throw new ValidationError('amountMinor must be a non-negative integer in minor units', {
      amountMinor: charge.amountMinor,
    });
  }
  if (!/^[A-Z]{3}$/.test(charge.currency)) {
    throw new ValidationError('currency must be a 3-letter ISO 4217 code', {
      currency: charge.currency,
    });
  }
  return charge;
}

export const RESERVATIONS_REPOSITORY = Symbol('RESERVATIONS_REPOSITORY');

@Injectable()
export class ReservationsService implements ReservationsPort {
  constructor(
    @Inject(RESERVATIONS_REPOSITORY) private readonly repo: PgReservationsRepository,
    @Inject(SERVICE_CATALOG_PORT) private readonly serviceCatalog: ServiceCatalogPort,
    @Inject(PARTY_DIRECTORY_PORT) private readonly parties: PartyDirectoryPort,
    @Inject(VEHICLE_DIRECTORY_PORT) private readonly vehicles: VehicleDirectoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async request(clientAccountId: AccountId, input: CreateReservationDTO): Promise<ReservationDTO> {
    const start = new Date(input.slotStart);
    const end = new Date(input.slotEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new ValidationError('slotStart/slotEnd must be ISO-8601 timestamps');
    }
    if (end <= start) throw new ValidationError('slotEnd must be after slotStart');
    if (start.getTime() < this.clock.now().getTime()) {
      throw new BusinessRuleError('SLOT_IN_PAST', 'Cannot book a slot in the past');
    }

    // service type is data-driven (§4.6) — validate via the catalogue port,
    // never by reading its schema
    const svc = await this.serviceCatalog.getServiceType(input.serviceTypeKey);
    if (!svc || !svc.active) {
      throw new BusinessRuleError('UNKNOWN_SERVICE_TYPE', `No active service type "${input.serviceTypeKey}"`);
    }
    if (svc.requiresVehicle && !input.vehicleId) {
      throw new BusinessRuleError('VEHICLE_REQUIRED', `Service "${svc.key}" requires a vehicle`);
    }

    return this.repo.create(clientAccountId, input);
  }

  listForClient(clientAccountId: AccountId, limit = 50): Promise<ReservationDTO[]> {
    return this.repo.listForClient(clientAccountId, Math.min(limit, 200));
  }

  async listForSupplier(supplierId: SupplierId, limit = 50): Promise<SupplierReservationDTO[]> {
    const rows = await this.repo.listForSupplier(supplierId, Math.min(limit, 200));
    return this.withParties(rows);
  }

  async getForSupplier(supplierId: SupplierId, id: ReservationId): Promise<SupplierReservationDTO> {
    const row = await this.repo.byIdForSupplier(supplierId, id);
    if (!row) throw new NotFoundError('Reservation', id);
    const [enriched] = await this.withParties([row]);
    return enriched;
  }

  /**
   * Resolve the customer and the car for bookings the supplier owns.
   *
   * Across module boundaries by port, never by SQL: reservations may
   * read its own schema and nothing else (§17.4). The vehicle read is
   * owner-scoped on the CLIENT NAMED ON THE BOOKING, so a supplier can
   * only ever resolve a car that was booked in with them.
   *
   * Deduplicated before fetching, because a workshop's calendar is
   * mostly the same handful of regulars: the four bookings on one
   * screen in the field were one customer and one car, which is one
   * lookup each rather than eight. Failures degrade to null instead of
   * failing the calendar - a directory being down is not a reason to
   * hide the day's work.
   */
  private async withParties(rows: ReservationDTO[]): Promise<SupplierReservationDTO[]> {
    if (rows.length === 0) return [];

    const accountIds = rows
      .map((r) => String(r.clientAccountId))
      .filter((id, i, all) => all.indexOf(id) === i);
    const vehicleKeys = rows
      .filter((r) => r.vehicleId !== null)
      .map((r) => `${r.clientAccountId}|${r.vehicleId}`)
      .filter((key, i, all) => all.indexOf(key) === i);

    const parties = new Map<string, PartyDTO | null>();
    const cars = new Map<string, VehicleSummaryDTO | null>();

    await Promise.all([
      ...accountIds.map(async (id) => {
        parties.set(id, await this.parties.partyFor(id).catch(() => null));
      }),
      ...vehicleKeys.map(async (key) => {
        const [owner, vehicleId] = key.split('|');
        cars.set(key, await this.vehicles.vehicleFor(owner, vehicleId).catch(() => null));
      }),
    ]);

    return rows.map((r) => ({
      ...r,
      customer: parties.get(String(r.clientAccountId)) ?? null,
      vehicle: r.vehicleId ? (cars.get(`${r.clientAccountId}|${r.vehicleId}`) ?? null) : null,
    }));
  }

  accept(supplierId: SupplierId, id: ReservationId): Promise<ReservationDTO> {
    return this.repo.transition(id, 'accepted', { supplierId });
  }

  reject(supplierId: SupplierId, id: ReservationId, reason?: string): Promise<ReservationDTO> {
    return this.repo.transition(id, 'rejected', { supplierId }, { note: reason });
  }

  reschedule(supplierId: SupplierId, id: ReservationId, input: RescheduleDTO): Promise<ReservationDTO> {
    if (new Date(input.slotEnd) <= new Date(input.slotStart)) {
      throw new ValidationError('slotEnd must be after slotStart');
    }
    return this.repo.transition(id, 'rescheduled', { supplierId }, { reschedule: input });
  }

  complete(supplierId: SupplierId, id: ReservationId, charge?: ChargeDTO): Promise<ReservationDTO> {
    return this.repo.transition(id, 'completed', { supplierId }, { charge: validCharge(charge) });
  }

  charge(supplierId: SupplierId, id: ReservationId, input: ChargeDTO): Promise<ReservationDTO> {
    return this.repo.charge(supplierId, id, validCharge(input) as ChargeDTO);
  }

  cancel(clientAccountId: AccountId, id: ReservationId): Promise<ReservationDTO> {
    return this.repo.transition(id, 'cancelled', { clientAccountId });
  }
}
