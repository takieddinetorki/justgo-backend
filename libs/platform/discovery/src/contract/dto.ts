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
