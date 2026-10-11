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
  /**
   * v2 (additive): city/country/rating for the Services Directory, which
   * browses without a location and so cannot rank by distance. Optional,
   * like everything before them — a consumer that ignores them is
   * unaffected (§12).
   */
  city?: string | null;
  country?: string | null;
  rating?: number | null;
}
