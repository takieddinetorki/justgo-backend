import { Body, Controller, Inject, Param, Patch } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ValidationError, type VehicleId } from '@justgo/kernel';
import { VEHICLES_PORT, type VehiclesPort } from './contract/vehicles.port';
import type { VehicleDTO } from './contract/dto';

const overrideSchema = z
  .object({
    mileageKm: z.number().int().nonnegative(),
    /*
      Required, and not merely for tidiness. Lowering a recorded odometer
      is the single most abusable write in this module — it is how a car
      is made to look less used than it is — so every one of them has to
      arrive with a stated cause attached to the operator's account id.
    */
    reason: z.string().min(3).max(500),
  })
  .strict();

/**
 * Support's correction desk for mileage.
 *
 * Owners cannot lower a value (`MILEAGE_LOWER`), which is the right rule
 * and also means a fat-fingered 150 000 is permanent without this. The
 * app's own copy says "contact JustGo Support", so the desk needs a way
 * to honour that.
 *
 * It is gated on its OWN permission, not on `platform.admin`: the desk
 * should be able to fix an odometer without also being able to void
 * documents and suspend businesses. Deliberately not owner-scoped — the
 * whole point is acting on somebody else's car — so the permission is
 * the only thing standing in front of it.
 */
@Controller('admin/vehicles')
export class AdminMileageController {
  constructor(@Inject(VEHICLES_PORT) private readonly vehicles: VehiclesPort) {}

  @Patch(':id/mileage')
  @RequirePermissions('support.mileage.override')
  async override(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VehicleDTO> {
    const parsed = overrideSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid mileage override', { issues: parsed.error.issues });
    }
    return this.vehicles.overrideMileage({
      vehicleId: asId<VehicleId>(id),
      mileageKm: parsed.data.mileageKm,
      actorAccountId: auth.accountId,
      reason: parsed.data.reason,
    });
  }
}
