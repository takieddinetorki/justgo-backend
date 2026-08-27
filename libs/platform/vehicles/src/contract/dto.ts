import type { AccountId, VehicleId } from '@justgo/kernel';

export type HealthStatus = 'optimal' | 'good' | 'warning' | 'critical' | 'urgent';
export type MaintenanceStatus = 'pending' | 'due' | 'done' | 'dismissed';

export interface VehicleDTO {
  id: VehicleId;
  ownerAccountId: AccountId;
  name: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
  plate: string | null;
  mileageKm: number | null;
  /** TecDoc KType — the id linking a vehicle to fitting parts (§22). */
  tecdocVehicleTypeId: number | null;
  tecdocManufacturerId: number | null;
  tecdocModelId: number | null;
  healthStatus: HealthStatus;
  photoUrl: string | null;
  createdAt: string;
}

export interface AddVehicleDTO {
  name?: string;
  brand?: string;
  model?: string;
  year?: number;
  vin?: string;
  plate?: string;
  mileageKm?: number;
  photoUrl?: string;
  /** When true (default), resolve KType from brand/model/year via TecDoc. */
  resolveTecDoc?: boolean;
}

export interface UpdateVehicleDTO {
  name?: string;
  plate?: string;
  photoUrl?: string;
  healthStatus?: HealthStatus;
}

export interface MaintenanceTaskDTO {
  id: string;
  vehicleId: VehicleId;
  title: string;
  intervalKm: number | null;
  intervalMonths: number | null;
  dueAtKm: number | null;
  dueDate: string | null;
  status: MaintenanceStatus;
  createdAt: string;
}

export interface AddMaintenanceTaskDTO {
  title: string;
  intervalKm?: number;
  intervalMonths?: number;
  dueAtKm?: number;
  dueDate?: string;
}

export interface HealthEntryDTO {
  id: string;
  vehicleId: VehicleId;
  systemArea: string | null;
  status: string | null;
  note: string | null;
  mileageKm: number | null;
  at: string;
}
