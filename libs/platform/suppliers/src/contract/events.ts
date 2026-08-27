export const SUPPLIER_REGISTERED = 'suppliers.SupplierRegistered';
/**
 * v1 (additive): lat/lng and categoryKeys were added for the discovery geo
 * index. They are optional so older consumers are unaffected (§12).
 */
export interface SupplierRegisteredV1 {
  supplierId: string;
  ownerAccountId: string;
  verticalKey: string;
  name: string;
  lat?: number | null;
  lng?: number | null;
  /** category coverage declared by the vertical (for category-filtered discovery). */
  categoryKeys?: string[];
}
