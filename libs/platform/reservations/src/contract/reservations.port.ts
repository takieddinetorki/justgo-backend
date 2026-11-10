import type { AccountId, ReservationId, SupplierId } from '@justgo/kernel';
import type {
  CreateReservationDTO,
  RescheduleDTO,
  ReservationDTO,
  SupplierReservationDTO,
} from './dto';

/** Public port of the reservations context (§6.1). */
export interface ReservationsPort {
  request(clientAccountId: AccountId, input: CreateReservationDTO): Promise<ReservationDTO>;
  listForClient(clientAccountId: AccountId, limit?: number): Promise<ReservationDTO[]>;
  listForSupplier(supplierId: SupplierId, limit?: number): Promise<SupplierReservationDTO[]>;
  /**
   * One booking, by id, for the supplier it was made with.
   *
   * THE DESTINATION OF A SCAN. The confirmation's QR resolves to a
   * document, the document names its subject, and this is what turns
   * that subject into the booking on screen. Without it the app could
   * only pull the whole calendar and hunt for a match, which is exactly
   * what it was reduced to doing: "Is this confirmation for one of your
   * bookings? Select it."
   *
   * Scoped to the supplier, and a booking belonging to someone else is
   * NOT FOUND rather than forbidden - a reservation id should not be
   * confirmable by a business it has nothing to do with.
   */
  getForSupplier(supplierId: SupplierId, id: ReservationId): Promise<SupplierReservationDTO>;
  accept(supplierId: SupplierId, id: ReservationId): Promise<ReservationDTO>;
  reject(supplierId: SupplierId, id: ReservationId, reason?: string): Promise<ReservationDTO>;
  reschedule(supplierId: SupplierId, id: ReservationId, input: RescheduleDTO): Promise<ReservationDTO>;
  complete(supplierId: SupplierId, id: ReservationId): Promise<ReservationDTO>;
  cancel(clientAccountId: AccountId, id: ReservationId): Promise<ReservationDTO>;
}

export const RESERVATIONS_PORT = Symbol('RESERVATIONS_PORT');
