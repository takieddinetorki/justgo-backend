import type { ExecutionContext } from '@nestjs/common';
import type { MileageCompliancePort } from '@justgo/contracts';
import { AUTH_CONTEXT, type AuthContext } from './auth-context';
import { MileageUpToDateGuard, MileageUpdateRequiredError } from './mileage-lock.guard';

/**
 * The lock, and the three ways a lock like this goes wrong.
 *
 * It can fail to lock (the app hides a screen, the endpoint behind it
 * answers anyway). It can lock the door it is meant to be the key for
 * (refuse the very endpoint that would clear it). And it can give the
 * app a 403 with no reason, leaving it nothing to put on screen.
 */

const OPEN: MileageCompliancePort = {
  complianceFor: async () => ({
    locked: false,
    reason: null,
    vehicleId: null,
    lastUpdatedAt: null,
    dueAt: null,
  }),
};

const LOCKED: MileageCompliancePort = {
  complianceFor: async () => ({
    locked: true,
    reason: 'MILEAGE_UPDATE_REQUIRED',
    vehicleId: 'veh-1',
    lastUpdatedAt: '2026-10-01T00:00:00.000Z',
    dueAt: '2026-10-31T00:00:00.000Z',
  }),
};

function ctx(auth: Partial<AuthContext> | null): ExecutionContext {
  const request: Record<string | symbol, unknown> = {};
  if (auth) request[AUTH_CONTEXT] = auth;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('the mileage lock', () => {
  it('lets a compliant account through', async () => {
    const guard = new MileageUpToDateGuard(OPEN);
    await expect(guard.canActivate(ctx({ accountId: 'acc-1' as never }))).resolves.toBe(true);
  });

  it('refuses an account with a stale reading', async () => {
    const guard = new MileageUpToDateGuard(LOCKED);
    await expect(guard.canActivate(ctx({ accountId: 'acc-1' as never }))).rejects.toThrow(
      MileageUpdateRequiredError,
    );
  });

  /*
    403 FORBIDDEN and 403 MILEAGE_UPDATE_REQUIRED need different screens:
    one is "you may not", the other is "do this and you may". The app
    branches on the code, so the code is the contract.
  */
  it('says WHY, and which car, so the app can act on it', async () => {
    const guard = new MileageUpToDateGuard(LOCKED);
    const error = await guard
      .canActivate(ctx({ accountId: 'acc-1' as never }))
      .then(() => null)
      .catch((e: MileageUpdateRequiredError) => e);

    expect(error).toBeInstanceOf(MileageUpdateRequiredError);
    expect(error?.code).toBe('MILEAGE_UPDATE_REQUIRED');
    expect(error?.httpStatus).toBe(403);
    expect(error?.details).toMatchObject({
      vehicleId: 'veh-1',
      dueAt: '2026-10-31T00:00:00.000Z',
    });
  });

  /*
    This guard runs after RbacGuard, which is what puts the context on
    the request. With no context there is no account to judge — and a
    request with no token has already been refused by then, so inventing
    a verdict here could only ever be the wrong one.
  */
  it('stands aside when there is no authenticated account', async () => {
    const asked: string[] = [];
    const guard = new MileageUpToDateGuard({
      complianceFor: async (id: string) => {
        asked.push(id);
        return LOCKED.complianceFor(id);
      },
    });
    await expect(guard.canActivate(ctx(null))).resolves.toBe(true);
    expect(asked).toEqual([]);
  });

  it('judges the caller, by their own account id', async () => {
    const asked: string[] = [];
    const guard = new MileageUpToDateGuard({
      complianceFor: async (id: string) => {
        asked.push(id);
        return OPEN.complianceFor(id);
      },
    });
    await guard.canActivate(ctx({ accountId: 'acc-42' as never }));
    expect(asked).toEqual(['acc-42']);
  });
});
