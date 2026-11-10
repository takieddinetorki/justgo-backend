/**
 * The car a booking is about, across a module boundary.
 *
 * A workshop that has accepted a reservation needs to know which vehicle
 * is arriving; `reservations` holds only a `vehicleId` and may not read
 * the vehicles schema (§17.4).
 *
 * THE OWNER IS PART OF THE QUESTION, not an optional filter. The caller
 * passes the account the vehicle must belong to — for a reservation,
 * the client named on that reservation — so this port can never be used
 * to read a car by id alone. It is the same owner-scoped read the garage
 * screens use; the supplier simply gets to make it for the one vehicle
 * that was booked in with them.
 */
export interface VehicleSummaryDTO {
  id: string;
  /** What the owner calls it, when they have named it. */
  name: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  /** Needed to order the right parts, and printed on the job sheet. */
  vin: string | null;
  plate: string | null;
  mileageKm: number | null;
}

export interface VehicleDirectoryPort {
  /** Null when there is no such vehicle, or it is not that owner's. */
  vehicleFor(ownerAccountId: string, vehicleId: string): Promise<VehicleSummaryDTO | null>;
}

export const VEHICLE_DIRECTORY_PORT = Symbol('VEHICLE_DIRECTORY_PORT');
