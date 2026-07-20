/** Events emitted by identity (§12). Versioned and additive. */

export const USER_REGISTERED = 'identity.UserRegistered';
export interface UserRegisteredV1 {
  accountId: string;
  authUserId: string;
  locale: string;
}

export const ROLE_ASSIGNED = 'identity.RoleAssigned';
export interface RoleAssignedV1 {
  accountId: string;
  roleKey: string;
  scopeType: 'global' | 'supplier' | 'branch';
  scopeId: string | null;
}
