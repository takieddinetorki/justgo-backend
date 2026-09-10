import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, type AccountId, type Uuid } from '@justgo/kernel';
import type { AccountDTO, ProfilePatchDTO, SupplierScopeDTO } from '../contract/dto';
import type { IdentityPort } from '../contract/identity.port';
import { Account } from '../domain/account';
import { PgIdentityRepository } from '../infra/pg-identity.repository';

import { DEFAULT_ROLE_KEY } from '../contract/roles';

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');
export { DEFAULT_ROLE_KEY };

function toDTO(account: Account): AccountDTO {
  return {
    id: account.id,
    authUserId: account.authUserId,
    firstName: account.firstName,
    familyName: account.familyName,
    email: account.email,
    phone: account.phone,
    locale: account.locale,
    roles: account.roles,
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
    return toDTO(await this.repo.ensure(authUserId, seed, DEFAULT_ROLE_KEY));
  }

  async getByAuthUserId(authUserId: Uuid): Promise<AccountDTO | null> {
    const account = await this.repo.findByAuthUserId(authUserId);
    return account ? toDTO(account) : null;
  }

  async getById(accountId: AccountId): Promise<AccountDTO | null> {
    const account = await this.repo.findById(accountId);
    return account ? toDTO(account) : null;
  }

  async updateProfile(accountId: AccountId, patch: ProfilePatchDTO): Promise<AccountDTO> {
    const account = await this.repo.findById(accountId);
    if (!account) throw new NotFoundError('Account', accountId);
    account.applyProfilePatch(patch);
    await this.repo.saveProfile(account);
    return toDTO(account);
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
    return account ? toDTO(account) : null;
  }
}
