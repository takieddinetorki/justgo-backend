import type { AccountId, SupplierId, VehicleId } from '@justgo/kernel';

export type AssistanceServiceType = 'breakdown' | 'tow' | 'battery' | 'tyre' | 'fuel' | 'lockout';
export type AssistanceStatus = 'requested' | 'dispatched' | 'en_route' | 'completed' | 'cancelled';

export interface AssistanceRequestDTO {
  id: string;
  clientAccountId: AccountId;
  vehicleId: VehicleId | null;
  serviceType: AssistanceServiceType;
  description: string | null;
  lat: number;
  lng: number;
  pickupAddress: string | null;
  assignedSupplierId: SupplierId | null;
  status: AssistanceStatus;
  createdAt: string;
}

export interface CreateAssistanceDTO {
  serviceType: AssistanceServiceType;
  lat: number;
  lng: number;
  vehicleId?: VehicleId;
  description?: string;
  pickupAddress?: string;
}
