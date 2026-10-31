import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessRuleError,
  NotFoundError,
  type AccountId,
  type SupplierId,
} from '@justgo/kernel';
import { VerticalRegistry } from '@justgo/contracts';
import type { SuppliersPort } from '../contract/suppliers.port';
import type {
  RegisterSupplierDTO,
  SetVerificationDTO,
  SupplierDTO,
  UpdateFiscalIdentityDTO,
  UpdateSupplierProfileDTO,
} from '../contract/dto';
import { assertCoordinatePair, assertOpeningHours } from '../domain/opening-hours';
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
    const vertical = this.verticals.byKey(input.verticalKey);
    const categoryKeys = vertical.catalogueSpec?.().categoryKeys ?? [];
    return this.repo.insert(ownerAccountId, input, { categoryKeys });
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

  async updateFiscalIdentity(
    id: SupplierId,
    patch: UpdateFiscalIdentityDTO,
  ): Promise<SupplierDTO> {
    const updated = await this.repo.updateFiscalIdentity(id, patch);
    if (!updated) throw new NotFoundError('Supplier', id);
    return updated;
  }

  async updateProfile(id: SupplierId, patch: UpdateSupplierProfileDTO): Promise<SupplierDTO> {
    assertOpeningHours(patch.hours);
    assertCoordinatePair(patch.lat, patch.lng);

    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundError('Supplier', id);
    /*
      A closed business is read-only. Re-opening is an ops decision — the
      fiscal identity, the reviews and the invoice history all belong to the
      entity that closed, and letting an owner flip it back silently would
      make "closed" mean nothing.
    */
    if (current.closedAt) {
      throw new BusinessRuleError(
        'SUPPLIER_CLOSED',
        'This business has been closed and can no longer be edited',
        { closedAt: current.closedAt },
      );
    }

    /*
      The read model indexes category coverage, and that comes from the
      vertical registry rather than from the row. Resolved here, where the
      registry lives, and passed down so the event carries it — a repository
      cannot ask, and an event that omitted it would leave the index
      preserving whatever it last heard.
    */
    const categoryKeys = this.verticals.has(current.verticalKey)
      ? (this.verticals.byKey(current.verticalKey).catalogueSpec?.().categoryKeys ?? [])
      : undefined;

    const updated = await this.repo.updateProfile(id, patch, { categoryKeys });
    if (!updated) throw new NotFoundError('Supplier', id);
    return updated;
  }

  async close(id: SupplierId): Promise<SupplierDTO> {
    const closed = await this.repo.close(id);
    if (!closed) throw new NotFoundError('Supplier', id);
    return closed;
  }

  async setVerification(
    id: SupplierId,
    input: SetVerificationDTO,
    decidedByAccountId: AccountId,
  ): Promise<SupplierDTO> {
    const decided = await this.repo.setVerification(id, input, decidedByAccountId);
    if (!decided) throw new NotFoundError('Supplier', id);
    return decided;
  }
}
