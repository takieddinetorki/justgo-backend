import { Pool } from 'pg';
import { asId, type AccountId, type Uuid } from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { Account } from '../domain/account';
import { ACCOUNT_ANONYMISED, ROLE_ASSIGNED, USER_REGISTERED } from '../contract/events';

interface AccountRow {
  id: string;
  auth_user_id: string;
  first_name: string | null;
  family_name: string | null;
  email: string | null;
  phone: string | null;
  dob: string | null;
  city: string | null;
  country: string | null;
  avatar_bucket: string | null;
  avatar_path: string | null;
  locale: string;
  deleted_at: Date | null;
  created_at: Date;
  roles: string[] | null;
}

/*
  `group by a.id` covers every column of `a`: id is the primary key, so
  Postgres treats the rest as functionally dependent on it. The aggregate is
  only there to collapse the role join into an array.

  `dob` comes back as a `YYYY-MM-DD` string rather than a Date because the
  pg driver is configured to leave `date` alone — a calendar date pushed
  through a timestamp shifts by a day either side of UTC, and a birthday
  that moves is worse than one that is a string.
*/
const SELECT_ACCOUNT = `
  select a.id, a.auth_user_id, a.first_name, a.family_name, a.email, a.phone,
         to_char(a.dob, 'YYYY-MM-DD') as dob, a.city, a.country,
         a.avatar_bucket, a.avatar_path,
         a.locale, a.deleted_at, a.created_at,
         array_remove(array_agg(r.key), null) as roles
    from identity.accounts a
    left join identity.user_roles ur on ur.account_id = a.id
    left join identity.roles r on r.id = ur.role_id
`;

/**
 * All SQL stays inside the identity schema (§17.4). State change + outbox
 * append share one transaction (§17.2).
 */
export class PgIdentityRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'identity');
  }

  private toAccount(row: AccountRow): Account {
    return new Account(
      asId<AccountId>(row.id),
      asId<Uuid>(row.auth_user_id),
      row.first_name,
      row.family_name,
      row.email,
      row.phone,
      row.locale,
      row.roles ?? [],
      row.created_at,
      row.dob,
      row.city,
      row.country,
      row.avatar_bucket && row.avatar_path
        ? { bucket: row.avatar_bucket, path: row.avatar_path }
        : null,
      row.deleted_at,
    );
  }

  async findByAuthUserId(authUserId: Uuid): Promise<Account | null> {
    const res = await this.pool.query<AccountRow>(
      `${SELECT_ACCOUNT} where a.auth_user_id = $1 group by a.id`,
      [authUserId],
    );
    return res.rows[0] ? this.toAccount(res.rows[0]) : null;
  }

  async findById(id: AccountId): Promise<Account | null> {
    const res = await this.pool.query<AccountRow>(
      `${SELECT_ACCOUNT} where a.id = $1 group by a.id`,
      [id],
    );
    return res.rows[0] ? this.toAccount(res.rows[0]) : null;
  }

  /**
   * Insert-if-absent keyed on auth_user_id; assigns the default role and
   * emits identity.UserRegistered only when a row was actually created.
   */
  async ensure(
    authUserId: Uuid,
    seed: { email?: string; phone?: string; locale?: string },
    defaultRoleKey: string,
  ): Promise<Account> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const inserted = await client.query<{ id: string }>(
        `insert into identity.accounts (auth_user_id, email, phone, locale)
         values ($1, $2, $3, coalesce($4, 'en'))
         on conflict (auth_user_id) do nothing
         returning id`,
        [authUserId, seed.email ?? null, seed.phone ?? null, seed.locale ?? null],
      );
      if (inserted.rows[0]) {
        const accountId = inserted.rows[0].id;
        await client.query(
          `insert into identity.user_roles (account_id, role_id, scope_type, scope_id)
           select $1, id, 'global', null from identity.roles where key = $2
           on conflict do nothing`,
          [accountId, defaultRoleKey],
        );
        await this.outbox.appendWith(client, [
          makeEvent({
            type: USER_REGISTERED,
            aggregateId: asId<Uuid>(accountId),
            payload: { accountId, authUserId, locale: seed.locale ?? 'en' },
          }),
        ]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const account = await this.findByAuthUserId(authUserId);
    if (!account) throw new Error('ensure() failed to load account after upsert');
    return account;
  }

  async saveProfile(account: Account): Promise<void> {
    await this.pool.query(
      `update identity.accounts
          set first_name = $2, family_name = $3, phone = $4, locale = $5,
              email = $6, dob = $7::date, city = $8, country = $9,
              avatar_bucket = $10, avatar_path = $11,
              updated_at = now()
        where id = $1`,
      [
        account.id,
        account.firstName,
        account.familyName,
        account.phone,
        account.locale,
        account.email,
        account.dob,
        account.city,
        account.country,
        account.avatar?.bucket ?? null,
        account.avatar?.path ?? null,
      ],
    );
  }

  /**
   * Does this account act for any business?
   *
   * Asked before closing an account, and answered from identity's OWN data:
   * a supplier-scoped row in `user_roles` is what makes somebody an owner,
   * so there is no need to read the suppliers schema (§17.4) to find out.
   */
  async hasSupplierScope(accountId: AccountId): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from identity.user_roles
        where account_id = $1 and scope_type in ('supplier', 'branch')
        limit 1`,
      [accountId],
    );
    return res.rowCount === 1;
  }

  /**
   * Close an account: blank the identifiers, drop every role.
   *
   * Both in one transaction, because they are one act. Leaving the roles
   * behind would anonymise a person who could still create orders; blanking
   * nothing and only dropping roles would lock them out while their name
   * stayed on the feed.
   *
   * The emitted event lets other modules react — a push token is worth
   * revoking — but no module HAS to: every one of them stores an account id
   * and reads the name from here, so this write anonymises the person across
   * the whole product on its own.
   */
  async anonymise(account: Account): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update identity.accounts
            set first_name = null, family_name = null, email = null, phone = null,
                dob = null, city = null, country = null,
                avatar_bucket = null, avatar_path = null,
                anonymised_at = coalesce(anonymised_at, now()),
                deleted_at = coalesce(deleted_at, now()),
                updated_at = now()
          where id = $1`,
        [account.id],
      );
      await client.query(`delete from identity.user_roles where account_id = $1`, [account.id]);
      await this.outbox.appendWith(client, [
        makeEvent({
          type: ACCOUNT_ANONYMISED,
          aggregateId: account.id,
          payload: {
            accountId: account.id,
            authUserId: account.authUserId,
            anonymisedAt: new Date().toISOString(),
          },
        }),
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async assignRole(
    accountId: AccountId,
    roleKey: string,
    scope: { type: 'supplier' | 'branch'; id: Uuid } | undefined,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query(
        `insert into identity.user_roles (account_id, role_id, scope_type, scope_id)
         select $1, id, $2, $3 from identity.roles where key = $4
         on conflict do nothing
         returning account_id`,
        [accountId, scope?.type ?? 'global', scope?.id ?? null, roleKey],
      );
      if (res.rows[0]) {
        await this.outbox.appendWith(client, [
          makeEvent({
            type: ROLE_ASSIGNED,
            aggregateId: accountId,
            payload: {
              accountId,
              roleKey,
              scopeType: scope?.type ?? 'global',
              scopeId: scope?.id ?? null,
            },
          }),
        ]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Take a global role away.
   *
   * The counterpart to `assignRole`, added for driver suspension: a role
   * granted by a check must be removable when the check stops holding, or
   * `driver.work` outlives the verification it came from.
   *
   * Scoped roles are NOT touched. A supplier scope is revoked by removing the
   * supplier, and a blanket delete here would strip every business an account
   * acts for.
   */
  async revokeGlobalRole(accountId: AccountId, roleKey: string): Promise<void> {
    await this.pool.query(
      `delete from identity.user_roles
        where account_id = $1
          and scope_type = 'global'
          and role_id = (select id from identity.roles where key = $2)`,
      [accountId, roleKey],
    );
  }

  /**
   * One lookup that accepts either key.
   *
   * `owner_account_id` on a supplier, and the `accountId` on events emitted
   * before session issuance existed, hold whatever the caller's token put
   * in AuthContext.accountId — which was the Supabase `sub` whenever the
   * token had no `account_id` claim. Matching on both columns lets old and
   * new tokens resolve to the same row instead of silently missing.
   */
  async findByIdOrAuthUserId(idOrAuthUserId: Uuid): Promise<Account | null> {
    const res = await this.pool.query<AccountRow>(
      `${SELECT_ACCOUNT} where a.id = $1 or a.auth_user_id = $1 group by a.id limit 1`,
      [idOrAuthUserId],
    );
    return res.rows[0] ? this.toAccount(res.rows[0]) : null;
  }

  /**
   * Supplier scopes come from identity's OWN table — `user_roles` rows with
   * scope_type 'supplier' or 'branch'. Reading suppliers.suppliers here
   * would cross a schema boundary (§17.4) and couple issuance to a module
   * identity does not depend on.
   *
   * A branch-scoped row still needs its supplier, which the row cannot give
   * us; branch scoping therefore stays unresolved until a branch role
   * carries both. Today only supplier-scoped rows are produced.
   */
  async supplierScopesOf(
    accountId: AccountId,
  ): Promise<Array<{ supplierId: Uuid; branchId: Uuid | null; roleKey: string }>> {
    const res = await this.pool.query<{
      scope_id: string;
      scope_type: string;
      key: string;
    }>(
      `select ur.scope_id, ur.scope_type, r.key
         from identity.user_roles ur
         join identity.roles r on r.id = ur.role_id
        where ur.account_id = $1
          and ur.scope_type = 'supplier'
          and ur.scope_id is not null
        order by r.key`,
      [accountId],
    );
    return res.rows.map((row) => ({
      supplierId: asId<Uuid>(row.scope_id),
      branchId: null,
      roleKey: row.key,
    }));
  }

  /**
   * Effective permissions FOR A SCOPE.
   *
   * Without the scope filter a supplier owner who is also a client gets
   * both role's permissions in one token, and a supplier session would
   * carry `request.create`. Passing a supplierId narrows to global roles
   * plus the roles granted on that supplier; passing none returns global
   * roles only.
   */
  async permissionsOfScoped(accountId: AccountId, supplierId: Uuid | null): Promise<string[]> {
    const res = await this.pool.query<{ key: string }>(
      `select distinct p.key
         from identity.user_roles ur
         join identity.role_permissions rp on rp.role_id = ur.role_id
         join identity.permissions p on p.id = rp.permission_id
        where ur.account_id = $1
          and (ur.scope_type = 'global' or ($2::uuid is not null and ur.scope_id = $2::uuid))
        order by p.key`,
      [accountId, supplierId],
    );
    return res.rows.map((r) => r.key);
  }

  /** Role keys under the same scoping rule as permissionsOfScoped. */
  async rolesOfScoped(accountId: AccountId, supplierId: Uuid | null): Promise<string[]> {
    const res = await this.pool.query<{ key: string }>(
      `select distinct r.key
         from identity.user_roles ur
         join identity.roles r on r.id = ur.role_id
        where ur.account_id = $1
          and (ur.scope_type = 'global' or ($2::uuid is not null and ur.scope_id = $2::uuid))
        order by r.key`,
      [accountId, supplierId],
    );
    return res.rows.map((r) => r.key);
  }

  async permissionsOf(accountId: AccountId): Promise<string[]> {
    const res = await this.pool.query<{ key: string }>(
      `select distinct p.key
         from identity.user_roles ur
         join identity.role_permissions rp on rp.role_id = ur.role_id
         join identity.permissions p on p.id = rp.permission_id
        where ur.account_id = $1
        order by p.key`,
      [accountId],
    );
    return res.rows.map((r) => r.key);
  }
}
