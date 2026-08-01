/**
 * Cross-module seam for Quote Engine fan-out (§9, Open Question §21.1).
 *
 * The requests module asks "who should receive this request?" without
 * knowing what a supplier is; the suppliers module answers without knowing
 * what a request is. Both depend only on shared contracts, so either can be
 * extracted to its own service by swapping this in-process implementation
 * for a network client (§4.8).
 *
 * Matching rules (radius, city, country, category coverage, in-stock only)
 * are an OPEN QUESTION — they live behind this interface, never hard-coded
 * into the core loop.
 */
export interface TargetingCriteria {
  /** Verticals that declared RECEIVES_PART_REQUESTS (capability-driven). */
  verticalKeys: string[];
  categoryKey: string | null;
  /** When set, fan-out targets exactly this supplier (strategy='single'). */
  targetSupplierId?: string;
}

export interface SupplierTargetingPort {
  /** Supplier ids that should receive a quote stub for this request. */
  targetsFor(criteria: TargetingCriteria): Promise<string[]>;
}

export const SUPPLIER_TARGETING_PORT = Symbol('SUPPLIER_TARGETING_PORT');
