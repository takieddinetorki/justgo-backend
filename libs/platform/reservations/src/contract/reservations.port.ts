import type { AccountId, ReservationId, SupplierId } from '@justgo/kernel';
import type { CreateReservationDTO, RescheduleDTO, ReservationDTO } from './dto';

/** Public port of the reservations context (§6.1). */
export interface ReservationsPort {
  request(clientAccountId: AccountId, input: CreateReservationDTO): Promise<ReservationDTO>;
  listForClient(clientAccountId: AccountId, limit?: number): Promise<ReservationDTO[]>;
  listForSupplier(supplierId: SupplierId, limit?: number): Promise<ReservationDTO[]>;
  accept(supplierId: SupplierId, id: ReservationId): Promise<ReservationDTO>;
  reject(supplierId: SupplierId, id: ReservationId, reason?: string): Promise<ReservationDTO>;
  reschedule(supplierId: SupplierId, id: ReservationId, input: RescheduleDTO): Promise<ReservationDTO>;
  complete(supplierId: SupplierId, id: ReservationId): Promise<ReservationDTO>;
  cancel(clientAccountId: AccountId, id: ReservationId): Promise<ReservationDTO>;
}

export const RESERVATIONS_PORT = Symbol('RESERVATIONS_PORT');
