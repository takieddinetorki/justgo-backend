import type { AccountId, Uuid } from '@justgo/kernel';
import type { AccountDTO, ProfilePatchDTO } from './dto';

/**
 * The identity module's public port (§6.1). Other modules resolve accounts
 * ONLY through this — never by touching the identity schema.
 */
export interface IdentityPort {
  /**
   * Idempotently maps a Supabase auth user to an account, creating it (with
   * the default role) on first sight. Emits identity.UserRegistered on
   * creation.
   */
  ensureAccount(authUserId: Uuid, seed?: { email?: string; phone?: string; locale?: string }): Promise<AccountDTO>;
  getByAuthUserId(authUserId: Uuid): Promise<AccountDTO | null>;
  getById(accountId: AccountId): Promise<AccountDTO | null>;
  updateProfile(accountId: AccountId, patch: ProfilePatchDTO): Promise<AccountDTO>;
  /** Role keys are data (identity.roles); scope per §7 user_roles. */
  assignRole(accountId: AccountId, roleKey: string, scope?: { type: 'supplier' | 'branch'; id: Uuid }): Promise<void>;
  /** Effective permission keys for an account (union over roles). */
  permissionsOf(accountId: AccountId): Promise<string[]>;
}

export const IDENTITY_PORT = Symbol('IDENTITY_PORT');
