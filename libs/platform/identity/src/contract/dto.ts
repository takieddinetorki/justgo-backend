import type { AccountId, Uuid } from '@justgo/kernel';

/** An image in a private bucket, as (bucket, path) — never a URL (§14). */
export interface AvatarRefDTO {
  bucket: string;
  path: string;
}

export interface AccountDTO {
  id: AccountId;
  authUserId: Uuid;
  firstName: string | null;
  familyName: string | null;
  /**
   * CONTACT email, not the sign-in identity. GoTrue owns the credential;
   * changing this does not change what you log in with.
   */
  email: string | null;
  phone: string | null;
  dob: string | null;
  city: string | null;
  country: string | null;
  avatar: AvatarRefDTO | null;
  locale: string;
  roles: string[];
  /**
   * Set once the account has been closed. The row survives — orders,
   * invoices and reviews reference it — but the person is anonymised and
   * holds no role, so every permissioned endpoint answers 403.
   */
  deletedAt: string | null;
  createdAt: string; // UTC ISO-8601
}

/**
 * `null` CLEARS a field; absent leaves it alone. A profile with no way to
 * remove an avatar or a phone number is a profile you can only ever add to.
 */
export interface ProfilePatchDTO {
  firstName?: string;
  familyName?: string;
  phone?: string | null;
  email?: string | null;
  /** `YYYY-MM-DD`. The column has existed since the first schema with no route. */
  dob?: string | null;
  city?: string | null;
  country?: string | null;
  avatar?: AvatarRefDTO | null;
  locale?: string;
}

/**
 * A supplier (or branch) this account may act for. Derived from
 * `identity.user_roles` rows scoped to a supplier — identity's own data,
 * so resolving a session never reaches into the suppliers schema.
 */
export interface SupplierScopeDTO {
  supplierId: Uuid;
  branchId: Uuid | null;
  roleKey: string;
}

/** What the caller asked their session to be scoped to. */
export interface SessionRequestDTO {
  /** Explicit supplier. Must be one of the account's scopes. */
  supplierId?: string;
  branchId?: string;
  /** `supplier` auto-selects when the account has exactly one scope. */
  scope?: 'client' | 'supplier';
}

export interface SessionDTO {
  accessToken: string;
  tokenType: 'Bearer';
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  account: AccountDTO;
  roles: string[];
  permissions: string[];
  /** Null for a client session. */
  supplier: { supplierId: Uuid; branchId: Uuid | null } | null;
  /** Everything this account COULD scope to, so the app can offer a choice. */
  supplierScopes: SupplierScopeDTO[];
}
