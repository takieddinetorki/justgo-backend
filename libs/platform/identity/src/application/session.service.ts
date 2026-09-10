import { Inject, Injectable } from '@nestjs/common';
import {
  TOKEN_SIGNER,
  TOKEN_VERIFIER,
  type JustGoClaims,
  type TokenSigner,
  type TokenVerifier,
} from '@justgo/auth';
import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  type Uuid,
} from '@justgo/kernel';
import type { SessionDTO, SessionRequestDTO, SupplierScopeDTO } from '../contract/dto';
import { DEFAULT_ROLE_KEY } from '../contract/roles';
import { PgIdentityRepository } from '../infra/pg-identity.repository';
import { IDENTITY_REPOSITORY } from './identity.service';

export const SESSION_TTL_SECONDS = Symbol('SESSION_TTL_SECONDS');

/** One hour, matching GoTrue's own default access-token lifetime. */
export const DEFAULT_SESSION_TTL_SECONDS = 3600;

/**
 * Trades a GoTrue access token for a JustGo session token.
 *
 * THE PROBLEM THIS SOLVES. GoTrue answers "who is this?"; it has no idea
 * what they may do here, because roles and permissions are rows in the
 * identity schema. A raw GoTrue token therefore arrives with `roles: []`
 * and `permissions: []`, and `RbacGuard` rejects every route carrying a
 * `@RequirePermissions('…')` — which is nearly all of them. Supplier
 * scope has the same shape of problem one level down: the `supplier_id`
 * claim that turns `GET /v1/orders` supplier-side cannot come from an
 * authentication server that has never heard of suppliers.
 *
 * WHAT IT PRESERVES. The minted token keeps GoTrue's `sub`, `role`, `aud`
 * and metadata untouched. That is not politeness — `sub` is what
 * `app.auth_user_id()` reads in every RLS policy, `role` is what
 * PostgREST switches into, and the apps send this same token to Supabase
 * Realtime. Dropping any of them breaks a surface far from here.
 *
 * WHAT IT NARROWS. Permissions are resolved FOR THE REQUESTED SCOPE. A
 * person who owns a garage and is also a client holds both role sets; a
 * supplier session that unioned them would carry `request.create`, and a
 * client session would carry `quote.submit`. Neither is true of the
 * session being asked for.
 *
 * The session never outlives the authentication behind it — see
 * `expiryFor`.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repo: PgIdentityRepository,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier | null,
    @Inject(SESSION_TTL_SECONDS) private readonly ttlSeconds: number,
  ) {}

  /**
   * A verifier without `verifyClaims` (a hand-written double, or a future
   * implementation) still authenticates — it just cannot hand back
   * GoTrue's extra claims, so the session carries only what we can prove.
   */
  private async rawClaims(bearerToken: string): Promise<JustGoClaims> {
    if (!this.verifier) throw new UnauthenticatedError('Authentication is not configured');
    if (this.verifier.verifyClaims) return this.verifier.verifyClaims(bearerToken);
    const ctx = await this.verifier.verify(bearerToken);
    return { sub: ctx.accountId as unknown as string, locale: ctx.locale };
  }

  async issue(bearerToken: string, request: SessionRequestDTO): Promise<SessionDTO> {
    if (!this.verifier) throw new UnauthenticatedError('Authentication is not configured');

    /*
      Re-verified here rather than reusing the guard's AuthContext: the
      context is a lossy projection and issuance needs the original claims.
      The cost is one HMAC check.
    */
    const claims: JustGoClaims = await this.rawClaims(bearerToken);

    const authUserId = claims.sub;
    if (!authUserId) throw new UnauthenticatedError('Token has no subject');

    /*
      Self-provisioning, exactly as GET /v1/me does. A user who signs up and
      immediately asks for a session should not have to know that some other
      endpoint had to be called first to create their account row.
    */
    const account = await this.repo.ensure(
      authUserId as Uuid,
      { email: typeof claims['email'] === 'string' ? claims['email'] : undefined, locale: claims.locale },
      DEFAULT_ROLE_KEY,
    );

    const scopes = await this.repo.supplierScopesOf(account.id);
    const chosen = selectScope(request, scopes);

    const supplierId = chosen?.supplierId ?? null;
    const [roles, permissions] = await Promise.all([
      this.repo.rolesOfScoped(account.id, supplierId),
      this.repo.permissionsOfScoped(account.id, supplierId),
    ]);

    const expiresAt = expiryFor(this.ttlSeconds, claims.exp);
    const accessToken = await this.signer.sign({
      base: claims,
      claims: {
        account_id: account.id,
        roles,
        permissions,
        locale: account.locale,
        ...(supplierId ? { supplier_id: supplierId } : {}),
        ...(chosen?.branchId ? { branch_id: chosen.branchId } : {}),
      },
      expiresAt,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
      account: {
        id: account.id,
        authUserId: account.authUserId,
        firstName: account.firstName,
        familyName: account.familyName,
        email: account.email,
        phone: account.phone,
        locale: account.locale,
        roles: account.roles,
        createdAt: account.createdAt.toISOString(),
      },
      roles,
      permissions,
      supplier: supplierId ? { supplierId, branchId: chosen?.branchId ?? null } : null,
      supplierScopes: scopes,
    };
  }
}

/**
 * A session must never outlive the authentication it was built on.
 *
 * If it could, a revoked or expired GoTrue session would keep working
 * through a token we minted from it — the refresh cycle would stop being
 * a control. So the expiry is the EARLIER of our TTL and the incoming
 * token's own. The practical consequence, which the integration guide
 * states: exchange right after sign-in and again after every refresh, not
 * once at install.
 */
export function expiryFor(ttlSeconds: number, upstreamExp: number | undefined): number {
  const ours = Math.floor(Date.now() / 1000) + ttlSeconds;
  return upstreamExp ? Math.min(ours, upstreamExp) : ours;
}

/**
 * Which supplier, if any, this session speaks for.
 *
 * Scoping is OPT-IN. Auto-scoping whenever an account happened to own a
 * supplier would silently flip a client's `GET /v1/orders` to the supplier
 * feed the day they registered a business. The Supplier app asks; the
 * Client app does not.
 */
export function selectScope(
  request: SessionRequestDTO,
  scopes: SupplierScopeDTO[],
): SupplierScopeDTO | null {
  if (request.supplierId) {
    const match = scopes.find((s) => s.supplierId === request.supplierId);
    if (!match) {
      throw new ForbiddenError('No supplier role on this account for the requested supplier', {
        supplierId: request.supplierId,
        available: scopes.map((s) => s.supplierId),
      });
    }
    return request.branchId
      ? { ...match, branchId: request.branchId as Uuid }
      : match;
  }

  if (request.scope !== 'supplier') return null;

  if (scopes.length === 0) {
    throw new ForbiddenError('This account has no supplier role', { available: [] });
  }
  if (scopes.length > 1) {
    // Guessing here would put the wrong business's inbox in front of them.
    throw new ValidationError('Account acts for several suppliers — name one', {
      available: scopes.map((s) => s.supplierId),
    });
  }
  return scopes[0] as SupplierScopeDTO;
}
