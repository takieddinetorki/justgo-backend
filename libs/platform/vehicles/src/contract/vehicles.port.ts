import type { AccountId, VehicleId } from '@justgo/kernel';
import type {
  AddMaintenanceTaskDTO,
  AddVehicleDTO,
  HealthEntryDTO,
  MaintenanceTaskDTO,
  UpdateVehicleDTO,
  VehicleDTO,
} from './dto';

/** Public port of the vehicles context (§6.1). */
export interface VehiclesPort {
  add(ownerAccountId: AccountId, input: AddVehicleDTO): Promise<VehicleDTO>;
  list(ownerAccountId: AccountId): Promise<VehicleDTO[]>;
  get(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<VehicleDTO>;
  update(ownerAccountId: AccountId, vehicleId: VehicleId, patch: UpdateVehicleDTO): Promise<VehicleDTO>;
  remove(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<void>;
  setMileage(ownerAccountId: AccountId, vehicleId: VehicleId, mileageKm: number): Promise<VehicleDTO>;

  addMaintenanceTask(ownerAccountId: AccountId, vehicleId: VehicleId, input: AddMaintenanceTaskDTO): Promise<MaintenanceTaskDTO>;
  listMaintenance(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<MaintenanceTaskDTO[]>;
  listHealth(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<HealthEntryDTO[]>;

  /** Worker-driven: flips due tasks to 'due' and emits MaintenanceDue (§13). */
  sweepDueMaintenance(now?: Date): Promise<number>;
}

export const VEHICLES_PORT = Symbol('VEHICLES_PORT');
