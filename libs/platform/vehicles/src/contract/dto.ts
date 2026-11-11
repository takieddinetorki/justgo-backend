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
  /**
   * When the mileage was last stated, by the server clock.
   *
   * NOT `updatedAt`, which moves when the car is renamed or its health
   * status changes. The app needs the date of the READING, and used to
   * keep its own by writing a `JG-MILEAGE:` maintenance task after every
   * confirmed update — a workaround any other client could skip.
   */
  mileageUpdatedAt: string;
  /**
   * True once the reading is at least MILEAGE_UPDATE_PERIOD_DAYS old.
   *
   * Computed in SQL against the DATABASE clock, so every container and
   * every device agrees, and the flag clears everywhere the instant a
   * valid reading is saved. No per-device state to go out of sync.
   */
  mileageUpdateRequired: boolean;
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

/**
 * How long a mileage reading stays current.
 *
 * In the contract rather than the domain because the client app shows
 * the same number on its own countdown, and because the published
 * surface may expose contract/ but not domain/.
 */
export const MILEAGE_UPDATE_PERIOD_DAYS = 30;

/** 422 when a reading would go backwards. The app translates it. */
export const MILEAGE_LOWER = 'MILEAGE_LOWER';

/** 403 on a notification-feeding endpoint while a reading is stale. */
export const MILEAGE_UPDATE_REQUIRED = 'MILEAGE_UPDATE_REQUIRED';

/** Who stated a reading: the owner, or support correcting a typo. */
export type MileageSource = 'client' | 'support';

/**
 * One recorded reading.
 *
 * `previousKm` is kept beside the new value rather than being left to be
 * inferred from the row before it, because a support correction can land
 * out of order and because the history is read as a list, not a chain.
 */
export interface MileageHistoryEntryDTO {
  id: string;
  vehicleId: VehicleId;
  previousKm: number | null;
  newKm: number;
  source: MileageSource;
  actorAccountId: AccountId | null;
  recordedAt: string;
}

/**
 * Whether this account may be shown its notifications.
 *
 * The app already hides them when a car is overdue; this is the same
 * answer computed where it cannot be skipped by calling the API directly.
 * It names the car that caused the lock so the app can send the user
 * straight to the right screen instead of to a list.
 */
export interface NotificationAccessDTO {
  locked: boolean;
  reason: 'MILEAGE_UPDATE_REQUIRED' | null;
  /** The overdue vehicle; the oldest one when several are overdue. */
  vehicleId: VehicleId | null;
  lastUpdatedAt: string | null;
  /** When it fell (or falls) due. */
  dueAt: string | null;
}
