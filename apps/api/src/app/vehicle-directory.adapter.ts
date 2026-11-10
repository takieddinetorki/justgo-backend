import { Inject, Injectable } from '@nestjs/common';
import type { VehicleDirectoryPort, VehicleSummaryDTO } from '@justgo/contracts';
import { VEHICLES_PORT, type VehiclesPort } from '@justgo/vehicles';
import type { AccountId, VehicleId } from '@justgo/kernel';

/**
 * Composition-root adapter joining the booking screens to `vehicles`
 * (§21.1).
 *
 * It calls the SAME owner-scoped read the client's own garage uses,
 * passing the owner the caller asserts — for a reservation, the client
 * named on it. There is no by-id-alone read to reach for, which is what
 * keeps a supplier from walking the vehicle table: the only cars they
 * can resolve are the ones booked in with them.
 *
 * A miss is null, not a throw. `vehicles.get` raises NotFound for both
 * "no such car" and "not that owner's car", and neither should fail a
 * booking card that is otherwise perfectly readable.
 */
@Injectable()
export class VehicleDirectoryAdapter implements VehicleDirectoryPort {
  constructor(@Inject(VEHICLES_PORT) private readonly vehicles: VehiclesPort) {}

  async vehicleFor(ownerAccountId: string, vehicleId: string): Promise<VehicleSummaryDTO | null> {
    try {
      const v = await this.vehicles.get(ownerAccountId as AccountId, vehicleId as VehicleId);
      return {
        id: v.id,
        name: v.name,
        brand: v.brand,
        model: v.model,
        year: v.year,
        vin: v.vin,
        plate: v.plate,
        mileageKm: v.mileageKm,
      };
    } catch {
      return null;
    }
  }
}
