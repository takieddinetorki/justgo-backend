import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError, type SupplierId, type Uuid } from '@justgo/kernel';
import type { BranchesPort } from '../contract/suppliers.port';
import type { BranchDTO, CreateBranchDTO, UpdateBranchDTO } from '../contract/dto';
import { assertCoordinatePair, assertOpeningHours } from '../domain/opening-hours';
import { PgBranchesRepository } from '../infra/pg-branches.repository';

export const BRANCHES_REPOSITORY = Symbol('BRANCHES_REPOSITORY');

/**
 * A branch is always reached through the supplier that owns it. There is no
 * `getBranch(id)` on this port on purpose: every method takes the supplier
 * id the caller's session is scoped to, so a branch belonging to another
 * business is simply not addressable rather than merely forbidden.
 */
@Injectable()
export class BranchesService implements BranchesPort {
  constructor(@Inject(BRANCHES_REPOSITORY) private readonly repo: PgBranchesRepository) {}

  async list(supplierId: SupplierId, opts: { includeClosed?: boolean } = {}): Promise<BranchDTO[]> {
    return this.repo.list(supplierId, opts.includeClosed ?? false);
  }

  async create(supplierId: SupplierId, input: CreateBranchDTO): Promise<BranchDTO> {
    if (!input.name?.trim()) throw new ValidationError('A branch needs a name');
    assertOpeningHours(input.hours);
    assertCoordinatePair(input.lat, input.lng);
    return this.repo.create(supplierId, { ...input, name: input.name.trim() });
  }

  async update(
    supplierId: SupplierId,
    branchId: Uuid,
    patch: UpdateBranchDTO,
  ): Promise<BranchDTO> {
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new ValidationError('A branch needs a name');
    }
    assertOpeningHours(patch.hours);
    assertCoordinatePair(patch.lat, patch.lng);
    const updated = await this.repo.update(supplierId, branchId, patch);
    if (!updated) throw new NotFoundError('Branch', branchId);
    return updated;
  }

  async close(supplierId: SupplierId, branchId: Uuid): Promise<BranchDTO> {
    const closed = await this.repo.close(supplierId, branchId);
    if (!closed) throw new NotFoundError('Branch', branchId);
    return closed;
  }
}
