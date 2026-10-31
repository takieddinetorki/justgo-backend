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

export const SUPPLIER_UPDATED = 'suppliers.SupplierUpdated';
/**
 * Anything that changes how a business is PRESENTED.
 *
 * One event rather than three (`ProfileEdited`, `Verified`, `Rated`) because
 * every consumer of all three is the same consumer doing the same thing: the
 * discovery read model re-indexing one row. Three types would mean three
 * subscriptions, three payload shapes and three chances for them to disagree
 * about what the row now says.
 *
 * Emitted by the profile edit, the verification decision and the rating
 * recomputation alike, inside the transaction that made the change (§17.2).
 *
 * **Every optional field is "unknown", not "cleared".** A rating change does
 * not know the vertical's category coverage, so it omits `categoryKeys`, and
 * the read model must preserve what it already holds rather than blank it.
 */
export interface SupplierUpdatedV1 {
  supplierId: string;
  verticalKey: string;
  name: string;
  lat?: number | null;
  lng?: number | null;
  categoryKeys?: string[];
  city?: string | null;
  country?: string | null;
  /** Always present: the emitting row knows it. */
  isOpen: boolean;
  isVerified: boolean;
  rating: number | null;
  ratingCount: number;
}

export const SUPPLIER_REVIEWED = 'suppliers.SupplierReviewed';
/**
 * A business was reviewed. For the notification the owner gets — the rating
 * is carried so a one-star can be surfaced differently from a five.
 */
export interface SupplierReviewedV1 {
  supplierId: string;
  reviewId: string;
  ownerAccountId: string;
  authorAccountId: string;
  rating: number;
  /** Short preview for a notification body; never the whole review. */
  preview: string | null;
}
