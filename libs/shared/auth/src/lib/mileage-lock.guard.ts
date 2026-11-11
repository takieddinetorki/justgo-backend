import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { MILEAGE_COMPLIANCE_PORT, type MileageCompliancePort } from '@justgo/contracts';
import { AppError } from '@justgo/kernel';
import { AUTH_CONTEXT, type AuthContext } from './auth-context';

/**
 * 403, with its own code.
 *
 * NOT `ForbiddenError`, which hardcodes `FORBIDDEN` — the app branches on
 * the code to decide between "you may not do this" and "update your
 * mileage and you may", and those need different screens. The details
 * carry the car so it can open the right one.
 */
export class MileageUpdateRequiredError extends AppError {
  readonly httpStatus = 403;
  constructor(details: Record<string, unknown> = {}) {
    super(
      'MILEAGE_UPDATE_REQUIRED',
      'Update the mileage on your vehicle to continue.',
      details,
    );
  }
}

/**
 * Turns the client app's notification lock into a real one.
 *
 * The app hides notifications while any of the account's cars has a
 * stale mileage reading. That is a screen, not a rule: the endpoints it
 * hides still answer anybody holding the token, so a client that skips
 * the check — or a rebuilt one, or curl — sees everything.
 *
 * Applied to the endpoints that FEED those notifications, and to nothing
 * else. Three things must stay reachable while locked or the user can
 * never get out:
 *
 *   • the mileage endpoints, which is how they unlock
 *   • `GET /v1/vehicles*`, which is how they find the car
 *   • sign-in, and `GET /v1/me/notification-access`, which is how the app
 *     learns why it is locked and which car to open
 *
 * 403 with `MILEAGE_UPDATE_REQUIRED` and the offending vehicle in the
 * details, because an app that is told only "forbidden" has nothing to
 * put on screen.
 *
 * ORDER MATTERS. This runs after `RbacGuard`, which is what puts the
 * AuthContext on the request. Without a context there is no account to
 * judge, and this guard stands aside rather than inventing an answer —
 * a request with no token has already been refused by then.
 *
 * The port is injected NON-OPTIONALLY on purpose. A guard that silently
 * resolves to null is a lock that silently opens, which is worse than no
 * lock at all because it looks like one. A mis-wired application refuses
 * to boot instead.
 */
@Injectable()
export class MileageUpToDateGuard implements CanActivate {
  constructor(
    @Inject(MILEAGE_COMPLIANCE_PORT) private readonly compliance: MileageCompliancePort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ [AUTH_CONTEXT]?: AuthContext }>();
    const auth = request[AUTH_CONTEXT];
    if (!auth) return true;

    const verdict = await this.compliance.complianceFor(auth.accountId);
    if (!verdict.locked) return true;

    throw new MileageUpdateRequiredError({
      vehicleId: verdict.vehicleId,
      lastUpdatedAt: verdict.lastUpdatedAt,
      dueAt: verdict.dueAt,
    });
  }
}
