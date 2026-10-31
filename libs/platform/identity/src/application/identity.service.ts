import { Inject, Injectable } from '@nestjs/common';
import { BusinessRuleError, NotFoundError, type AccountId, type Uuid } from '@justgo/kernel';
import type { AccountDTO, ProfilePatchDTO, SupplierScopeDTO } from '../contract/dto';
import type { IdentityPort } from '../contract/identity.port';
import { Account } from '../domain/account';
import { PgIdentityRepository } from '../infra/pg-identity.repository';

import { DEFAULT_ROLE_KEY } from '../contract/roles';

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');
export { DEFAULT_ROLE_KEY };

/**
 * The one mapper from the Account entity to the DTO.
 *
 * Exported because the session service returns an account inside the
 * session, and it used to build that object by hand — so every field added
 * here had to be remembered there too. It was not, which is how a session's
 * account could end up shaped differently from the one `GET /v1/me` returns.
 */
export function accountToDTO(account: Account): AccountDTO {
  return {
    id: account.id,
    authUserId: account.authUserId,
    firstName: account.firstName,
    familyName: account.familyName,
    email: account.email,
    phone: account.phone,
    dob: account.dob,
    city: account.city,
    country: account.country,
    avatar: account.avatar,
    locale: account.locale,
    roles: account.roles,
    deletedAt: account.deletedAt ? account.deletedAt.toISOString() : null,
    createdAt: account.createdAt.toISOString(),
  };
}

/** Use-cases are thin (§17.1); domain rules live on Account. */
@Injectable()
export class IdentityService implements IdentityPort {
  constructor(@Inject(IDENTITY_REPOSITORY) private readonly repo: PgIdentityRepository) {}

  async ensureAccount(
    authUserId: Uuid,
    seed: { email?: string; phone?: string; locale?: string } = {},
  ): Promise<AccountDTO> {
    return accountToDTO(await this.repo.ensure(authUserId, seed, DEFAULT_ROLE_KEY));
  }

  /**
   * Resolve by EITHER id, and provision only on genuine first contact.
   *
   * The order matters and is the whole fix: `ensureAccount` first would
   * insert a ghost account keyed on the account id it was handed. See
   * `IdentityPort.currentAccount`.
   */
  async currentAccount(
    idOrAuthUserId: Uuid,
    seed: { email?: string; phone?: string; locale?: string } = {},
  ): Promise<AccountDTO> {
    const existing = await this.repo.findByIdOrAuthUserId(idOrAuthUserId);
    if (existing) return accountToDTO(existing);
    return this.ensureAccount(idOrAuthUserId, seed);
  }

  async getByAuthUserId(authUserId: Uuid): Promise<AccountDTO | null> {
    const account = await this.repo.findByAuthUserId(authUserId);
    return account ? accountToDTO(account) : null;
  }

  async getById(accountId: AccountId): Promise<AccountDTO | null> {
    const account = await this.repo.findById(accountId);
    return account ? accountToDTO(account) : null;
  }

  async updateProfile(accountId: AccountId, patch: ProfilePatchDTO): Promise<AccountDTO> {
    const account = await this.repo.findById(accountId);
    if (!account) throw new NotFoundError('Account', accountId);
    account.applyProfilePatch(patch);
    await this.repo.saveProfile(account);
    return accountToDTO(account);
  }

  async assignRole(
    accountId: AccountId,
    roleKey: string,
    scope?: { type: 'supplier' | 'branch'; id: Uuid },
  ): Promise<void> {
    await this.repo.assignRole(accountId, roleKey, scope);
  }

  async permissionsOf(accountId: AccountId): Promise<string[]> {
    return this.repo.permissionsOf(accountId);
  }

  async supplierScopesOf(accountId: AccountId): Promise<SupplierScopeDTO[]> {
    return this.repo.supplierScopesOf(accountId);
  }

  async resolveAccount(idOrAuthUserId: Uuid): Promise<AccountDTO | null> {
    const account = await this.repo.findByIdOrAuthUserId(idOrAuthUserId);
    return account ? accountToDTO(account) : null;
  }

  /**
   * Close an account, by anonymising it.
   *
   * Refused while the account still acts for a business. A supplier is not
   * personal data: it has invoices, orders and reviews of its own, and
   * silently orphaning one because its owner left would leave a shop in
   * discovery that nobody can answer for. Close the business first — that is
   * `DELETE /v1/supplier/profile`, and it is the owner's decision, not a
   * side effect of this one.
   */
  async closeAccount(accountId: AccountId): Promise<AccountDTO> {
    const account = await this.repo.findById(accountId);
    if (!account) throw new NotFoundError('Account', accountId);
    // Idempotent: closing a closed account is what a retried request does.
    if (account.isClosed) return accountToDTO(account);

    if (await this.repo.hasSupplierScope(accountId)) {
      throw new BusinessRuleError(
        'ACCOUNT_OWNS_BUSINESS',
        'Close the business you own before closing your account',
      );
    }

    account.anonymise(new Date());
    await this.repo.anonymise(account);
    const closed = await this.repo.findById(accountId);
    return accountToDTO(closed ?? account);
  }
}
