import { SignJWT } from 'jose';
import { JoseTokenSigner, UnavailableTokenSigner } from './jwt-signer';
import { JoseTokenVerifier } from './jwt-verifier';

const SECRET = 'a-test-secret-that-is-at-least-32-chars!!';
const AUTH_USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const SUPPLIER = '33333333-3333-4333-8333-333333333333';

/** Stands in for what self-hosted GoTrue actually hands the apps. */
async function gotrueToken(over: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    role: 'authenticated',
    email: 'owner@example.com',
    session_id: 'sess-1',
    app_metadata: { provider: 'email' },
    ...over,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(AUTH_USER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
}

describe('JoseTokenSigner', () => {
  const signer = new JoseTokenSigner({ secret: SECRET });
  const verifier = new JoseTokenVerifier({ secret: SECRET });
  const in10Min = () => Math.floor(Date.now() / 1000) + 600;

  it('mints a token our own verifier accepts', async () => {
    const base = await new JoseTokenVerifier({ secret: SECRET }).verifyClaims(
      await gotrueToken(),
    );

    const token = await signer.sign({
      base,
      claims: { account_id: ACCOUNT, roles: ['client'], permissions: ['request.create'] },
      expiresAt: in10Min(),
    });

    const ctx = await verifier.verify(token);
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.permissions).toContain('request.create');
  });

  /*
    The claims below are load-bearing far from this file: `sub` is what
    app.auth_user_id() reads in every RLS policy, and `role` is what
    PostgREST switches into. A session token that dropped them would
    authenticate here and fail against the database.
  */
  it('carries GoTrue’s own claims forward', async () => {
    const base = await verifier.verifyClaims(await gotrueToken());
    const token = await signer.sign({ base, claims: {}, expiresAt: in10Min() });

    const claims = await verifier.verifyClaims(token);
    expect(claims.sub).toBe(AUTH_USER);
    expect(claims['role']).toBe('authenticated');
    expect(claims['session_id']).toBe('sess-1');
    expect(claims['app_metadata']).toEqual({ provider: 'email' });
    expect(claims.aud).toBe('authenticated');
  });

  it('regenerates exp rather than inheriting the upstream one', async () => {
    const base = await verifier.verifyClaims(await gotrueToken());
    const expiresAt = in10Min();
    const token = await signer.sign({ base, claims: {}, expiresAt });

    const claims = await verifier.verifyClaims(token);
    expect(claims.exp).toBe(expiresAt);
    expect(claims.exp).not.toBe(base.exp);
  });

  it('lets our claims win over same-named upstream ones', async () => {
    const base = await verifier.verifyClaims(await gotrueToken({ roles: ['spoofed'] }));
    const token = await signer.sign({
      base,
      claims: { roles: ['client'], supplier_id: SUPPLIER },
      expiresAt: in10Min(),
    });

    const ctx = await verifier.verify(token);
    expect(ctx.roles).toEqual(['client']);
    expect(ctx.supplierScope?.supplierId).toBe(SUPPLIER);
  });

  it('refuses to sign when the deployment verifies asymmetrically', async () => {
    await expect(new UnavailableTokenSigner().sign()).rejects.toMatchObject({
      code: 'SESSION_ISSUANCE_UNAVAILABLE',
      httpStatus: 501,
    });
  });
});
