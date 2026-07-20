/**
 * RLS isolation proof (§11, §17.5) — the highest-risk area gets a test per
 * policy. Skipped without DATABASE_URL; CI applies migrations first.
 */
import { Pool } from 'pg';
import { newId, type Uuid } from '@justgo/kernel';
import { PgIdentityRepository } from './pg-identity.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

describePg('identity RLS isolation', () => {
  let pool: Pool;
  let repo: PgIdentityRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // seed the default role in case db/seed hasn't run in this environment
    await pool.query(
      `insert into identity.roles (key, label) values ('client', 'Client')
       on conflict (key) do nothing`,
    );
    repo = new PgIdentityRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Runs fn inside a tx impersonating a PostgREST `authenticated` request. */
  async function asUser<T>(authUserId: string, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: authUserId, role: 'authenticated' }),
      ]);
      await client.query('set local role authenticated');
      return await fn((sql, p) => client.query(sql, p));
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  it('a user reads their own account but not others', async () => {
    const alice = newId<Uuid>();
    const mallory = newId<Uuid>();
    const aliceAccount = await repo.ensure(alice, { email: 'alice@example.com' }, 'client');
    await repo.ensure(mallory, {}, 'client');

    const own = await asUser(alice, (q) =>
      q(`select id, email from identity.accounts`),
    );
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0]['id']).toBe(aliceAccount.id);

    const other = await asUser(mallory, (q) =>
      q(`select id from identity.accounts where auth_user_id = $1`, [alice]),
    );
    expect(other.rows).toHaveLength(0);
  });

  it('a user cannot update another user’s account', async () => {
    const alice = newId<Uuid>();
    const mallory = newId<Uuid>();
    await repo.ensure(alice, {}, 'client');
    await repo.ensure(mallory, {}, 'client');

    const res = await asUser(mallory, (q) =>
      q(`update identity.accounts set first_name = 'pwned' where auth_user_id = $1 returning id`, [
        alice,
      ]),
    );
    expect(res.rows).toHaveLength(0); // zero rows visible to update

    const check = await pool.query(
      `select first_name from identity.accounts where auth_user_id = $1`,
      [alice],
    );
    expect(check.rows[0].first_name).toBeNull();
  });

  it('registration emits identity.UserRegistered exactly once via the outbox', async () => {
    const authUserId = newId<Uuid>();
    const account = await repo.ensure(authUserId, {}, 'client');
    await repo.ensure(authUserId, {}, 'client'); // idempotent retry

    const events = await pool.query(
      `select type from identity.outbox where aggregate_id = $1`,
      [account.id],
    );
    expect(events.rows.map((r) => r.type)).toEqual(['identity.UserRegistered']);
  });

  it('permissionsOf unions role permissions', async () => {
    await pool.query(
      `insert into identity.permissions (key) values ('request.create')
       on conflict (key) do nothing`,
    );
    await pool.query(
      `insert into identity.role_permissions (role_id, permission_id)
       select r.id, p.id from identity.roles r, identity.permissions p
        where r.key = 'client' and p.key = 'request.create'
       on conflict do nothing`,
    );
    const account = await repo.ensure(newId<Uuid>(), {}, 'client');
    const perms = await repo.permissionsOf(account.id);
    expect(perms).toContain('request.create');
  });
});
