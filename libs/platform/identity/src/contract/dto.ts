import type { AccountId, Uuid } from '@justgo/kernel';

export interface AccountDTO {
  id: AccountId;
  authUserId: Uuid;
  firstName: string | null;
  familyName: string | null;
  email: string | null;
  phone: string | null;
  locale: string;
  roles: string[];
  createdAt: string; // UTC ISO-8601
}

export interface ProfilePatchDTO {
  firstName?: string;
  familyName?: string;
  phone?: string;
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
