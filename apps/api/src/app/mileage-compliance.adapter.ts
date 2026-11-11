import { Inject, Injectable } from '@nestjs/common';
import type { MileageComplianceDTO, MileageCompliancePort } from '@justgo/contracts';
import { asId, type AccountId } from '@justgo/kernel';
import { VEHICLES_PORT, type VehiclesPort } from '@justgo/vehicles';

/**
 * Binds the mileage lock to the module that can actually answer it (§21.1).
 *
 * `MileageUpToDateGuard` guards endpoints inside the requests, orders and
 * reservations modules, none of which may read `vehicles.*` (§17.4). The
 * guard asks this; this asks the vehicles module, which answers from its
 * own schema with its own clock.
 *
 * FAIL OPEN, deliberately, and only on an infrastructure failure. If the
 * vehicles module cannot be reached the account is let through rather
 * than locked out: the lock exists to make people type in their odometer,
 * not to take the product down with one module. A closed-on-error lock
 * would turn a vehicles outage into "nobody can see their orders", and
 * the worst a fail-open costs is that a stale reading goes unchased for
 * the length of the outage.
 */
@Injectable()
export class MileageComplianceAdapter implements MileageCompliancePort {
  constructor(@Inject(VEHICLES_PORT) private readonly vehicles: VehiclesPort) {}

  async complianceFor(accountId: string): Promise<MileageComplianceDTO> {
    try {
      const access = await this.vehicles.notificationAccess(asId<AccountId>(accountId));
      return {
        locked: access.locked,
        reason: access.reason,
        vehicleId: access.vehicleId,
        lastUpdatedAt: access.lastUpdatedAt,
        dueAt: access.dueAt,
      };
    } catch {
      return { locked: false, reason: null, vehicleId: null, lastUpdatedAt: null, dueAt: null };
    }
  }
}
