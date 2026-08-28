import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessRuleError,
  CLOCK,
  ValidationError,
  type AccountId,
  type Clock,
  type ReservationId,
  type SupplierId,
} from '@justgo/kernel';
import { SERVICE_CATALOG_PORT, type ServiceCatalogPort } from '@justgo/contracts';
import type { ReservationsPort } from '../contract/reservations.port';
import type { CreateReservationDTO, RescheduleDTO, ReservationDTO } from '../contract/dto';
import { PgReservationsRepository } from '../infra/pg-reservations.repository';

export const RESERVATIONS_REPOSITORY = Symbol('RESERVATIONS_REPOSITORY');

@Injectable()
export class ReservationsService implements ReservationsPort {
  constructor(
    @Inject(RESERVATIONS_REPOSITORY) private readonly repo: PgReservationsRepository,
    @Inject(SERVICE_CATALOG_PORT) private readonly serviceCatalog: ServiceCatalogPort,
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

  listForSupplier(supplierId: SupplierId, limit = 50): Promise<ReservationDTO[]> {
    return this.repo.listForSupplier(supplierId, Math.min(limit, 200));
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

  complete(supplierId: SupplierId, id: ReservationId): Promise<ReservationDTO> {
    return this.repo.transition(id, 'completed', { supplierId });
  }

  cancel(clientAccountId: AccountId, id: ReservationId): Promise<ReservationDTO> {
    return this.repo.transition(id, 'cancelled', { clientAccountId });
  }
}
