import { Inject, Injectable } from '@nestjs/common';
import type { SupplierTargetingPort, TargetingCriteria } from '@justgo/contracts';
import { SUPPLIERS_PORT, type SuppliersPort } from '@justgo/suppliers';

/**
 * Composition-root adapter binding the requests module's targeting seam to
 * the suppliers module (§21.1). Neither module depends on the other; the
 * app wires them through the shared contract, so either can be extracted
 * to its own service by swapping this for a network client (§4.8).
 */
@Injectable()
export class SupplierTargetingAdapter implements SupplierTargetingPort {
  constructor(@Inject(SUPPLIERS_PORT) private readonly suppliers: SuppliersPort) {}

  async targetsFor(criteria: TargetingCriteria): Promise<string[]> {
    // strategy='single' — the client picked one supplier; honor it verbatim
    if (criteria.targetSupplierId) return [criteria.targetSupplierId];
    return this.suppliers.eligibleForPartRequest(criteria.verticalKeys, criteria.categoryKey);
  }
}
