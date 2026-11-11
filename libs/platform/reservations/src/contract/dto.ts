import type { PartyDTO, VehicleSummaryDTO } from '@justgo/contracts';
import type { AccountId, BranchId, ReservationId, SupplierId, VehicleId } from '@justgo/kernel';

export type ReservationStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'rescheduled'
  | 'completed'
  | 'cancelled';

export interface ReservationDTO {
  id: ReservationId;
  clientAccountId: AccountId;
  supplierId: SupplierId;
  branchId: BranchId | null;
  serviceTypeKey: string;
  vehicleId: VehicleId | null;
  slotStart: string;
  slotEnd: string;
  status: ReservationStatus;
  note: string | null;
  createdAt: string;
  /**
   * What the supplier charged, in integer minor units. `null` until the
   * job is finished and priced — and it stays null for a completion that
   * carried no charge, which is a real outcome and not missing data.
   */
  amountMinor: number | null;
  currency: string | null;
  /** When the amount was stated, which can be after the completion. */
  chargedAt: string | null;
}

/**
 * What the supplier sees: the same booking, plus who is bringing which
 * car.
 *
 * A SEPARATE TYPE, not two optional fields on `ReservationDTO`, because
 * the audience is what decides whether they may be filled. The client
 * reading their own booking has no business being handed their own
 * contact card back, and nothing outside the supplier endpoints should
 * be able to resolve a customer by accident.
 *
 * Both blocks are nullable and that is normal: a service that needs no
 * vehicle has none, and most accounts on this deployment have no name
 * because nothing ever asked for one. A null reaches the screen as
 * "unknown", which is honest. It used to reach the screen as "Client ·
 * 4ab5bb55" — the first segment of a primary key, dressed as a person.
 */
export interface SupplierReservationDTO extends ReservationDTO {
  customer: PartyDTO | null;
  vehicle: VehicleSummaryDTO | null;
}

export interface CreateReservationDTO {
  supplierId: SupplierId;
  branchId?: BranchId;
  serviceTypeKey: string;
  vehicleId?: VehicleId;
  slotStart: string;
  slotEnd: string;
  note?: string;
}

export interface RescheduleDTO {
  slotStart: string;
  slotEnd: string;
}

/** What a supplier charged for a finished job. */
export interface ChargeDTO {
  amountMinor: number;
  currency: string;
}
