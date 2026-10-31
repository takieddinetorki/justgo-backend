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

export const ACCOUNT_ANONYMISED = 'identity.AccountAnonymised';
/**
 * The person asked for their account to be closed.
 *
 * Consumers do NOT have to anonymise anything of their own: every module
 * references an account by id and reads the name from identity, so the write
 * that emits this has already removed the person from the product. The event
 * exists for the things that are not a name — a push token worth revoking, a
 * cache worth busting.
 *
 * What it explicitly does NOT mean is "erase this person's records". Orders,
 * reservations and reclamations belong to the other party as well, and
 * issued invoices may not be altered at all.
 */
export interface AccountAnonymisedV1 {
  accountId: string;
  authUserId: string;
  anonymisedAt: string;
}
