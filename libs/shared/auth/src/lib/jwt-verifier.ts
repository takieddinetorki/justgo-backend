import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { asId, UnauthenticatedError, type AccountId, type BranchId, type SupplierId } from '@justgo/kernel';
import type { AuthContext } from './auth-context';

export interface JwtVerifierOptions {
  /** JWKS endpoint of the self-hosted Supabase GoTrue, e.g. `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` */
  jwksUrl: string;
  issuer?: string;
  audience?: string;
}

export interface TokenVerifier {
  verify(bearerToken: string): Promise<AuthContext>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Custom claims we mirror into the JWT for RLS parity (§11). */
interface JustGoClaims extends JWTPayload {
  account_id?: string;
  roles?: string[];
  permissions?: string[];
  supplier_id?: string;
  branch_id?: string;
  locale?: string;
}

export class JoseTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: JwtVerifierOptions) {
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  }

  async verify(bearerToken: string): Promise<AuthContext> {
    let claims: JustGoClaims;
    try {
      const { payload } = await jwtVerify(bearerToken, this.jwks, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
      });
      claims = payload as JustGoClaims;
    } catch {
      throw new UnauthenticatedError('Invalid or expired token');
    }
    return claimsToContext(claims);
  }
}

/** Exposed separately so tests can build contexts without a live JWKS. */
export function claimsToContext(claims: JustGoClaims): AuthContext {
  const accountId = claims.account_id ?? claims.sub;
  if (!accountId) throw new UnauthenticatedError('Token has no account identity');
  const ctx: AuthContext = {
    accountId: asId<AccountId>(accountId),
    roles: claims.roles ?? [],
    permissions: claims.permissions ?? [],
    locale: claims.locale ?? 'en',
  };
  if (claims.supplier_id) {
    ctx.supplierScope = {
      supplierId: asId<SupplierId>(claims.supplier_id),
      ...(claims.branch_id ? { branchId: asId<BranchId>(claims.branch_id) } : {}),
    };
  }
  return ctx;
}
