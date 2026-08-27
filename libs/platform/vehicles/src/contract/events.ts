export const VEHICLE_ADDED = 'vehicles.VehicleAdded';
export interface VehicleAddedV1 {
  vehicleId: string;
  ownerAccountId: string;
  brand: string | null;
  model: string | null;
  tecdocVehicleTypeId: number | null;
}

export const MAINTENANCE_DUE = 'vehicles.MaintenanceDue';
export interface MaintenanceDueV1 {
  taskId: string;
  vehicleId: string;
  ownerAccountId: string;
  title: string;
}
