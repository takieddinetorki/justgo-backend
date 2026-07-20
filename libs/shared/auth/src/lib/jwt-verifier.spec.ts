import { SignJWT } from 'jose';
import { UnauthenticatedError } from '@justgo/kernel';
import { JoseTokenVerifier } from './jwt-verifier';

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const ACCOUNT = '3f6c2c9a-6a10-4e6b-9b2e-0d5f6a7b8c9d';

async function sign(claims: Record<string, unknown>, secret = SECRET): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

describe('JoseTokenVerifier (HS256, self-hosted GoTrue)', () => {
  const verifier = new JoseTokenVerifier({ secret: SECRET });

  it('verifies a valid token and builds the AuthContext', async () => {
    const token = await sign({
      sub: ACCOUNT,
      roles: ['client'],
      permissions: ['request.create'],
      locale: 'fr',
    });
    const ctx = await verifier.verify(token);
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.roles).toEqual(['client']);
    expect(ctx.permissions).toEqual(['request.create']);
    expect(ctx.locale).toBe('fr');
    expect(ctx.supplierScope).toBeUndefined();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await sign({ sub: ACCOUNT }, 'another-secret-also-32-characters-long!!');
    await expect(verifier.verify(token)).rejects.toThrow(UnauthenticatedError);
  });

  it('rejects garbage tokens', async () => {
    await expect(verifier.verify('not.a.jwt')).rejects.toThrow(UnauthenticatedError);
  });

  it('requires secret or jwksUrl', () => {
    expect(() => new JoseTokenVerifier({})).toThrow(TypeError);
  });
});
