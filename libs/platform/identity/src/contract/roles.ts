/**
 * Role keys identity assigns itself.
 *
 * These are DATA — rows in `identity.roles`, seeded in `db/seed/seed.sql` —
 * but the two the module grants programmatically are named here so a typo
 * is a compile error rather than a role assignment that silently inserts
 * nothing (`assignRole` selects the role by key, so an unknown key is a
 * no-op).
 *
 * They live in `contract/` because that is the module's public layer; the
 * architecture tests reject a public entry point that re-exports anything
 * from `application/`, `domain/` or `infra/`.
 */

/** Assigned on first sight of a Supabase user (§7). */
export const DEFAULT_ROLE_KEY = 'client';

/** Granted on the business an account has just registered. */
export const SUPPLIER_OWNER_ROLE = 'supplier_owner';
