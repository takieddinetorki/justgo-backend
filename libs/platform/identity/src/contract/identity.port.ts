import type { AccountId, Uuid } from '@justgo/kernel';
import type { AccountDTO, ProfilePatchDTO, SupplierScopeDTO } from './dto';

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
  /**
   * The account behind an AuthContext — resolve first, provision only if
   * nothing is there.
   *
   * `AuthContext.accountId` is `account_id ?? sub`: an identity account id
   * when the caller holds a JustGo session token, and a Supabase auth user
   * id when they hold a raw GoTrue one. `ensureAccount` keys on
   * `auth_user_id` ALONE, so handing it an account id inserted a SECOND
   * account whose `auth_user_id` was the first one's primary key — a ghost
   * row with its own default role, which `/v1/me` then read and wrote while
   * the caller's real orders, documents and reviews hung off the original.
   *
   * Every call the apps make after the session exchange carries the session
   * token, so that was every `/v1/me` call. Found by the live smoke test.
   */
  currentAccount(
    idOrAuthUserId: Uuid,
    seed?: { email?: string; phone?: string; locale?: string },
  ): Promise<AccountDTO>;
  getByAuthUserId(authUserId: Uuid): Promise<AccountDTO | null>;
  getById(accountId: AccountId): Promise<AccountDTO | null>;
  updateProfile(accountId: AccountId, patch: ProfilePatchDTO): Promise<AccountDTO>;
  /**
   * Close an account: the identifiers are blanked and every role is dropped,
   * but the row survives because other people's records reference it.
   * Issued documents keep the name they were issued under — see
   * `Account.anonymise`. Idempotent.
   */
  closeAccount(accountId: AccountId): Promise<AccountDTO>;
  /** Role keys are data (identity.roles); scope per §7 user_roles. */
  assignRole(accountId: AccountId, roleKey: string, scope?: { type: 'supplier' | 'branch'; id: Uuid }): Promise<void>;
  /** Effective permission keys for an account (union over roles). */
  permissionsOf(accountId: AccountId): Promise<string[]>;
  /** Suppliers this account may act for, from its scoped role assignments. */
  supplierScopesOf(accountId: AccountId): Promise<SupplierScopeDTO[]>;
  /**
   * Resolves either an `identity.accounts.id` or a Supabase `auth.users.id`
   * to an account. Both circulate as "the account id" — a token minted
   * before session issuance existed carries the auth user id in `sub` and
   * nothing else — so consumers that receive one from an event or an older
   * token can still land on the right row.
   */
  resolveAccount(idOrAuthUserId: Uuid): Promise<AccountDTO | null>;
}

export const IDENTITY_PORT = Symbol('IDENTITY_PORT');
