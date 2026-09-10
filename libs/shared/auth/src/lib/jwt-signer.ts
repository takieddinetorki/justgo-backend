import { SignJWT, type JWTPayload } from 'jose';
import { AppError } from '@justgo/kernel';


/**
 * Mints the API's own session tokens (§11).
 *
 * WHY THIS EXISTS: GoTrue authenticates a person; it does not know what
 * that person may DO here. Roles and permissions are data in the identity
 * schema, and a raw GoTrue access token carries neither — so every route
 * behind `@RequirePermissions(...)` rejects it. The session token is the
 * exchange: same subject, same signing key, plus the claims this API and
 * its RLS policies actually read.
 *
 * SYMMETRIC ONLY, deliberately. Self-hosted GoTrue signs HS256 with
 * JWT_SECRET and this API verifies with that same secret, so signing with
 * it produces a token indistinguishable in trust from GoTrue's own. In an
 * asymmetric (JWKS) deployment we hold no private key and issuance is
 * refused rather than silently downgraded.
 */
export interface SessionTokenInput {
  /** Claims carried forward from the caller's GoTrue token. */
  base: JWTPayload;
  /** Claims this API adds. Overwrite anything of the same name in `base`. */
  claims: Record<string, unknown>;
  /** Absolute expiry, seconds since epoch. */
  expiresAt: number;
}

export interface TokenSigner {
  sign(input: SessionTokenInput): Promise<string>;
}

export const TOKEN_SIGNER = Symbol('TOKEN_SIGNER');

/**
 * Claims the signer always regenerates. Carrying an old `exp` or `iat`
 * forward would either mint a token that is already expired or one that
 * outlives its own authorisation.
 */
const REGENERATED = new Set(['exp', 'iat', 'nbf', 'jti', 'iss']);

export interface JwtSignerOptions {
  /** HS256 shared secret — the same one the verifier uses. */
  secret: string;
  issuer?: string;
  audience?: string;
}

export class JoseTokenSigner implements TokenSigner {
  private readonly key: Uint8Array;

  constructor(private readonly opts: JwtSignerOptions) {
    if (!opts.secret) throw new TypeError('JwtSignerOptions requires a secret');
    this.key = new TextEncoder().encode(opts.secret);
  }

  async sign({ base, claims, expiresAt }: SessionTokenInput): Promise<string> {
    const payload: JWTPayload = {};
    for (const [k, v] of Object.entries(base)) {
      if (!REGENERATED.has(k)) payload[k] = v;
    }
    Object.assign(payload, claims);

    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(now)
      .setExpirationTime(expiresAt);

    /*
      Only stamp iss/aud when the verifier is configured to check them.
      Setting an audience the verifier does not expect makes the token we
      just minted fail our own gate on the very next request.
    */
    if (this.opts.issuer) jwt.setIssuer(this.opts.issuer);
    if (this.opts.audience) jwt.setAudience(this.opts.audience);
    else if (typeof base['aud'] === 'string') jwt.setAudience(base['aud']);

    return jwt.sign(this.key);
  }
}

/** 501 — this deployment holds no key it may sign with. */
export class SessionIssuanceUnavailableError extends AppError {
  readonly httpStatus = 501;
  constructor() {
    super(
      'SESSION_ISSUANCE_UNAVAILABLE',
      'Session issuance requires a symmetric JWT_SECRET; this deployment verifies asymmetrically.',
    );
  }
}

/**
 * Stand-in for deployments that verify through JWKS. It fails loudly on
 * use: a no-op signer would hand out unsigned or wrongly-signed tokens,
 * and the failure would surface as a 401 somewhere else entirely.
 */
export class UnavailableTokenSigner implements TokenSigner {
  async sign(): Promise<string> {
    throw new SessionIssuanceUnavailableError();
  }
}
