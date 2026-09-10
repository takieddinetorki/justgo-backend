import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { asId, UnauthenticatedError, type AccountId, type BranchId, type SupplierId } from '@justgo/kernel';
import type { AuthContext } from './auth-context';

export interface JwtVerifierOptions {
  /**
   * HS256 shared secret — self-hosted Supabase GoTrue signs symmetric by
   * default (JWT_SECRET in the stack's .env). Takes precedence over jwksUrl.
   */
  secret?: string;
  /** JWKS endpoint for asymmetric setups, e.g. `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` */
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
}

export interface TokenVerifier {
  verify(bearerToken: string): Promise<AuthContext>;
  /**
   * The raw verified payload.
   *
   * Session issuance needs the claims themselves, not the AuthContext
   * derived from them: GoTrue puts `role`, `aud`, `session_id` and the
   * metadata blobs in there, and a session token that dropped them would
   * stop working against Supabase Realtime and PostgREST — surfaces the
   * apps reach with the same token. Optional so hand-written test
   * verifiers stay valid.
   */
  verifyClaims?(bearerToken: string): Promise<JustGoClaims>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Custom claims we mirror into the JWT for RLS parity (§11). */
export interface JustGoClaims extends JWTPayload {
  account_id?: string;
  roles?: string[];
  permissions?: string[];
  supplier_id?: string;
  branch_id?: string;
  locale?: string;
}

export class JoseTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private readonly secretKey: Uint8Array | null;

  constructor(private readonly opts: JwtVerifierOptions) {
    if (!opts.secret && !opts.jwksUrl) {
      throw new TypeError('JwtVerifierOptions requires secret (HS256) or jwksUrl');
    }
    this.secretKey = opts.secret ? new TextEncoder().encode(opts.secret) : null;
    this.jwks = !opts.secret && opts.jwksUrl ? createRemoteJWKSet(new URL(opts.jwksUrl)) : null;
  }

  async verify(bearerToken: string): Promise<AuthContext> {
    return claimsToContext(await this.verifyClaims(bearerToken));
  }

  async verifyClaims(bearerToken: string): Promise<JustGoClaims> {
    const verifyOpts = { issuer: this.opts.issuer, audience: this.opts.audience };
    try {
      const { payload } = this.secretKey
        ? await jwtVerify(bearerToken, this.secretKey, verifyOpts)
        : await jwtVerify(bearerToken, this.jwks as ReturnType<typeof createRemoteJWKSet>, verifyOpts);
      return payload as JustGoClaims;
    } catch {
      throw new UnauthenticatedError('Invalid or expired token');
    }
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
