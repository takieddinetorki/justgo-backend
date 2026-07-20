import { Inject, Injectable } from '@nestjs/common';
import { BusinessRuleError, type AccountId, type SupplierId } from '@justgo/kernel';
import { VerticalRegistry } from '@justgo/contracts';
import type { SuppliersPort } from '../contract/suppliers.port';
import type { RegisterSupplierDTO, SupplierDTO } from '../contract/dto';
import { PgSuppliersRepository } from '../infra/pg-suppliers.repository';

export const SUPPLIERS_REPOSITORY = Symbol('SUPPLIERS_REPOSITORY');

@Injectable()
export class SuppliersService implements SuppliersPort {
  constructor(
    @Inject(SUPPLIERS_REPOSITORY) private readonly repo: PgSuppliersRepository,
    private readonly verticals: VerticalRegistry,
  ) {}

  async register(ownerAccountId: AccountId, input: RegisterSupplierDTO): Promise<SupplierDTO> {
    // vertical keys are plug-in data — the registry is the authority (§9)
    if (!this.verticals.has(input.verticalKey)) {
      throw new BusinessRuleError(
        'UNKNOWN_VERTICAL',
        `No vertical registered under "${input.verticalKey}"`,
        { known: this.verticals.all().map((v) => v.key) },
      );
    }
    const existing = await this.repo.findByOwner(ownerAccountId);
    if (existing) {
      throw new BusinessRuleError(
        'SUPPLIER_ALREADY_REGISTERED',
        'This account already owns a supplier business',
        { supplierId: existing.id },
      );
    }
    return this.repo.insert(ownerAccountId, input);
  }

  async getById(id: SupplierId): Promise<SupplierDTO | null> {
    return this.repo.findById(id);
  }

  async getByOwner(ownerAccountId: AccountId): Promise<SupplierDTO | null> {
    return this.repo.findByOwner(ownerAccountId);
  }

  async eligibleForPartRequest(
    verticalKeys: string[],
    categoryKey: string | null,
  ): Promise<SupplierId[]> {
    return this.repo.eligibleForPartRequest(verticalKeys, categoryKey);
  }
}
