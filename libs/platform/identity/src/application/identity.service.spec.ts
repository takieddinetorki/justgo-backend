import { newId, NotFoundError, ValidationError, type AccountId, type Uuid } from '@justgo/kernel';
import { Account } from '../domain/account';
import { IdentityService } from './identity.service';
import type { PgIdentityRepository } from '../infra/pg-identity.repository';

/** In-memory stand-in honoring the repository surface. */
class FakeRepo {
  accounts = new Map<string, Account>();
  roleAssignments: { accountId: string; roleKey: string }[] = [];

  async findByAuthUserId(authUserId: Uuid): Promise<Account | null> {
    return [...this.accounts.values()].find((a) => a.authUserId === authUserId) ?? null;
  }
  async findById(id: AccountId): Promise<Account | null> {
    return this.accounts.get(id) ?? null;
  }
  async ensure(
    authUserId: Uuid,
    seed: { email?: string; locale?: string },
    defaultRoleKey: string,
  ): Promise<Account> {
    const existing = await this.findByAuthUserId(authUserId);
    if (existing) return existing;
    const account = new Account(
      newId<AccountId>(),
      authUserId,
      null,
      null,
      seed.email ?? null,
      null,
      seed.locale ?? 'en',
      [defaultRoleKey],
      new Date(),
    );
    this.accounts.set(account.id, account);
    return account;
  }
  async saveProfile(account: Account): Promise<void> {
    this.accounts.set(account.id, account);
  }
  supplierScopes = new Set<string>();
  async hasSupplierScope(accountId: AccountId): Promise<boolean> {
    return this.supplierScopes.has(accountId);
  }
  async anonymise(account: Account): Promise<void> {
    // The real repository blanks the columns and drops every role in one
    // transaction; the entity has already been anonymised by the time it
    // gets here, so the stub only has to persist it.
    this.accounts.set(account.id, account);
  }
  async assignRole(accountId: AccountId, roleKey: string): Promise<void> {
    this.roleAssignments.push({ accountId, roleKey });
  }
  async permissionsOf(): Promise<string[]> {
    return ['request.create'];
  }
}

describe('IdentityService', () => {
  const setup = () => {
    const repo = new FakeRepo();
    return { repo, service: new IdentityService(repo as unknown as PgIdentityRepository) };
  };

  it('ensureAccount is idempotent and assigns the default role', async () => {
    const { service } = setup();
    const authUserId = newId<Uuid>();
    const first = await service.ensureAccount(authUserId, { locale: 'fr' });
    const second = await service.ensureAccount(authUserId);
    expect(second.id).toBe(first.id);
    expect(first.roles).toEqual(['client']);
    expect(first.locale).toBe('fr');
  });

  it('updates a profile through domain validation', async () => {
    const { service } = setup();
    const account = await service.ensureAccount(newId<Uuid>());
    const updated = await service.updateProfile(account.id, {
      firstName: '  Taki ',
      locale: 'es',
    });
    expect(updated.firstName).toBe('Taki');
    expect(updated.locale).toBe('es');
  });

  it('closes an account by anonymising it, not by deleting the row', async () => {
    const { repo, service } = setup();
    const account = await service.ensureAccount(newId<Uuid>());
    await service.updateProfile(account.id, { firstName: 'Taki', phone: '+213555000111' });

    const closed = await service.closeAccount(account.id);

    expect(closed.firstName).toBeNull();
    expect(closed.phone).toBeNull();
    expect(closed.email).toBeNull();
    expect(closed.deletedAt).not.toBeNull();
    // The row survives: orders, invoices and reviews reference it, and they
    // belong to the other party as much as to this one.
    expect(await repo.findById(account.id)).not.toBeNull();
  });

  it('closing twice is idempotent', async () => {
    const { service } = setup();
    const account = await service.ensureAccount(newId<Uuid>());
    const first = await service.closeAccount(account.id);
    const second = await service.closeAccount(account.id);
    expect(second.deletedAt).toBe(first.deletedAt);
  });

  it('refuses to close an account that still acts for a business', async () => {
    const { repo, service } = setup();
    const account = await service.ensureAccount(newId<Uuid>());
    repo.supplierScopes.add(account.id);
    await expect(service.closeAccount(account.id)).rejects.toMatchObject({
      code: 'ACCOUNT_OWNS_BUSINESS',
    });
  });

  it('a closed account cannot be edited back to life', async () => {
    const { service } = setup();
    const account = await service.ensureAccount(newId<Uuid>());
    await service.closeAccount(account.id);
    await expect(service.updateProfile(account.id, { firstName: 'Taki' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects unsupported locales with a 400 ValidationError', async () => {
    const { service } = setup();
    const account = await service.ensureAccount(newId<Uuid>());
    await expect(service.updateProfile(account.id, { locale: 'de' as 'en' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('404s on updating a missing account', async () => {
    const { service } = setup();
    await expect(service.updateProfile(newId<AccountId>(), {})).rejects.toThrow(NotFoundError);
  });
});
