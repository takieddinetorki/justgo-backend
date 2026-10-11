import type { SupplierId } from '@justgo/kernel';

export interface NearbyQuery {
  lat: number;
  lng: number;
  /** search radius in metres (bounded by the service). */
  radiusM?: number;
  /** restrict to these vertical keys (the app resolves capability -> keys). */
  verticalKeys?: string[];
  /** restrict to suppliers covering this category. */
  categoryKey?: string;
  limit?: number;
}

export interface NearbySupplierDTO {
  supplierId: SupplierId;
  verticalKey: string;
  name: string;
  categoryKeys: string[];
  distanceM: number;
}

/**
 * Services Directory query — browse, not proximity.
 *
 * Everything is optional, including location. That is the whole point:
 * `NearbyQuery` cannot answer "show me body shops in Alger" because it
 * demands a lat/lng the user may not have granted, and ranks by a
 * distance that is then meaningless.
 */
export interface DirectoryQuery {
  /** Fuzzy match on supplier name (trigram). */
  q?: string;
  verticalKeys?: string[];
  categoryKey?: string;
  city?: string;
  /** When given, each row carries `distanceM` and results rank by it. */
  lat?: number;
  lng?: number;
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

export interface DirectorySupplierDTO {
  supplierId: SupplierId;
  verticalKey: string;
  name: string;
  categoryKeys: string[];
  city: string | null;
  country: string | null;
  rating: number | null;
  /** Only present when the query supplied a location. */
  distanceM?: number;
}

export interface DirectoryPage {
  items: DirectorySupplierDTO[];
  /** Null when this is the last page. */
  nextCursor: string | null;
}
