import type { AccountId, VehicleId } from '@justgo/kernel';
import type {
  AddMaintenanceTaskDTO,
  AddVehicleDTO,
  HealthEntryDTO,
  MaintenanceTaskDTO,
  MileageHistoryEntryDTO,
  NotificationAccessDTO,
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
  /** Refuses a lower reading with `MILEAGE_LOWER`; equal is accepted. */
  setMileage(ownerAccountId: AccountId, vehicleId: VehicleId, mileageKm: number): Promise<VehicleDTO>;
  listMileageHistory(
    ownerAccountId: AccountId,
    vehicleId: VehicleId,
    limit?: number,
  ): Promise<MileageHistoryEntryDTO[]>;
  /**
   * Support's correction. NOT owner-scoped on purpose — the desk is acting
   * on somebody else's car — so the only thing standing in front of it is
   * the `support.mileage.override` permission.
   */
  overrideMileage(input: {
    vehicleId: VehicleId;
    mileageKm: number;
    actorAccountId: AccountId;
    reason: string;
  }): Promise<VehicleDTO>;
  /** Locked if ANY of the account's cars has a stale reading. */
  notificationAccess(accountId: AccountId): Promise<NotificationAccessDTO>;

  addMaintenanceTask(ownerAccountId: AccountId, vehicleId: VehicleId, input: AddMaintenanceTaskDTO): Promise<MaintenanceTaskDTO>;
  listMaintenance(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<MaintenanceTaskDTO[]>;
  listHealth(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<HealthEntryDTO[]>;

  /** Worker-driven: flips due tasks to 'due' and emits MaintenanceDue (§13). */
  sweepDueMaintenance(now?: Date): Promise<number>;
}

export const VEHICLES_PORT = Symbol('VEHICLES_PORT');
