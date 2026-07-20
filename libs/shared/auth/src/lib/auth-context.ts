import type { AccountId, BranchId, SupplierId } from '@justgo/kernel';

/**
 * Built from a verified Supabase JWT on every request (§11). Roles and
 * permissions are DATA (identity schema), mirrored into JWT claims so
 * self-hosted Supabase RLS can enforce the same isolation.
 */
export interface AuthContext {
  accountId: AccountId;
  roles: string[];
  permissions: string[];
  supplierScope?: {
    supplierId: SupplierId;
    branchId?: BranchId;
  };
  locale: string;
}

export const AUTH_CONTEXT = 'authContext';

export function hasPermission(ctx: AuthContext, permission: string): boolean {
  return ctx.permissions.includes(permission);
}
