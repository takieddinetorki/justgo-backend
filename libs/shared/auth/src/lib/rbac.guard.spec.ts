import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError, UnauthenticatedError } from '@justgo/kernel';
import { RbacGuard, PERMISSIONS_KEY, PUBLIC_KEY } from './rbac.guard';
import { AUTH_CONTEXT } from './auth-context';
import { claimsToContext, type TokenVerifier } from './jwt-verifier';

const ACCOUNT = '3f6c2c9a-6a10-4e6b-9b2e-0d5f6a7b8c9d';
const SUPPLIER = '9b2e0d5f-6a7b-4c9d-8e1f-3f6c2c9a6a10';

function makeContext(
  meta: Record<string, unknown>,
  headers: Record<string, string> = {},
): { ctx: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = { headers };
  const ctx = {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  jest
    .spyOn(Reflector.prototype, 'getAllAndOverride')
    .mockImplementation((key: unknown) => meta[key as string]);
  return { ctx, request };
}

const verifier: TokenVerifier = {
  verify: async (token: string) => {
    if (token !== 'good') throw new UnauthenticatedError('Invalid or expired token');
    return claimsToContext({
      account_id: ACCOUNT,
      roles: ['supplier_owner'],
      permissions: ['quote.submit'],
      supplier_id: SUPPLIER,
    });
  },
};

afterEach(() => jest.restoreAllMocks());

describe('RbacGuard', () => {
  const guard = () => new RbacGuard(new Reflector(), verifier);

  it('lets @Public routes through without a token', async () => {
    const { ctx } = makeContext({ [PUBLIC_KEY]: true });
    await expect(guard().canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a missing bearer token with 401', async () => {
    const { ctx } = makeContext({});
    await expect(guard().canActivate(ctx)).rejects.toThrow(UnauthenticatedError);
  });

  it('rejects a bad token with 401', async () => {
    const { ctx } = makeContext({}, { authorization: 'Bearer bad' });
    await expect(guard().canActivate(ctx)).rejects.toThrow(UnauthenticatedError);
  });

  it('attaches AuthContext and enforces permissions', async () => {
    const { ctx, request } = makeContext(
      { [PERMISSIONS_KEY]: ['quote.submit'] },
      { authorization: 'Bearer good' },
    );
    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    const auth = request[AUTH_CONTEXT] as ReturnType<typeof claimsToContext>;
    expect(auth.accountId).toBe(ACCOUNT);
    expect(auth.supplierScope?.supplierId).toBe(SUPPLIER);
  });

  it('rejects a missing permission with 403 naming what is missing', async () => {
    const { ctx } = makeContext(
      { [PERMISSIONS_KEY]: ['listing.publish'] },
      { authorization: 'Bearer good' },
    );
    await expect(guard().canActivate(ctx)).rejects.toMatchObject({
      constructor: ForbiddenError,
      details: { required: ['listing.publish'] },
    });
  });

  it('rejects everything when no verifier is configured', async () => {
    const { ctx } = makeContext({}, { authorization: 'Bearer good' });
    const unconfigured = new RbacGuard(new Reflector(), null);
    await expect(unconfigured.canActivate(ctx)).rejects.toThrow(UnauthenticatedError);
  });
});
