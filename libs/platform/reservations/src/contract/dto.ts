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
