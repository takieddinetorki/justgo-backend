import { Controller, Get, Inject } from '@nestjs/common';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { VEHICLES_PORT, type VehiclesPort } from './contract/vehicles.port';
import type { NotificationAccessDTO } from './contract/dto';

/**
 * `GET /v1/me/notification-access` — may this account be shown its
 * notifications?
 *
 * WHY THIS LIVES IN THE VEHICLES MODULE rather than in identity, where
 * the rest of `/v1/me` lives. The answer is derived entirely from
 * `vehicles.vehicles.mileage_updated_at`, and a module may only query
 * its own schema (§17.4). Identity would have to ask through a port and
 * then compute the comparison in JS, on an API container's clock,
 * against a timestamp written by Postgres — the exact split-brain the
 * SQL-side comparison exists to avoid. The route is where the data is.
 *
 * Nest is happy with two controllers sharing the `me` prefix as long as
 * the full paths differ; `IdentityController` owns `/v1/me` itself.
 *
 * It is READABLE WHILE LOCKED, and has to be: this is the endpoint that
 * tells the app why it is locked and which car to open. An endpoint that
 * only answers once you are already compliant answers nothing.
 */
@Controller('me')
export class NotificationAccessController {
  constructor(@Inject(VEHICLES_PORT) private readonly vehicles: VehiclesPort) {}

  @Get('notification-access')
  @RequirePermissions('me.read')
  async access(@CurrentAuth() auth: AuthContext): Promise<NotificationAccessDTO> {
    return this.vehicles.notificationAccess(auth.accountId);
  }
}
