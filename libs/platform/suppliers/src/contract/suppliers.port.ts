import type { AccountId, SupplierId } from '@justgo/kernel';
import type { RegisterSupplierDTO, SupplierDTO } from './dto';

/**
 * Public port of the suppliers context (§6.1). The Quote Engine targets
 * suppliers exclusively through eligibleForPartRequest — matching rules
 * behind this seam are an Open Question (§21.1); today: open suppliers of
 * the given verticals, optionally filtering on catalogue category.
 */
export interface SuppliersPort {
  register(ownerAccountId: AccountId, input: RegisterSupplierDTO): Promise<SupplierDTO>;
  getById(id: SupplierId): Promise<SupplierDTO | null>;
  getByOwner(ownerAccountId: AccountId): Promise<SupplierDTO | null>;
  eligibleForPartRequest(verticalKeys: string[], categoryKey: string | null): Promise<SupplierId[]>;
}

export const SUPPLIERS_PORT = Symbol('SUPPLIERS_PORT');
