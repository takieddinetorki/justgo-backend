import type { NearbyQuery, NearbySupplierDTO } from './dto';

/** Public port of the discovery read model (§6.1). */
export interface DiscoveryPort {
  nearby(query: NearbyQuery): Promise<NearbySupplierDTO[]>;
  /** Upsert one supplier into the geo index (called by the event reactor). */
  indexSupplier(input: {
    supplierId: string;
    verticalKey: string;
    name: string;
    lat: number | null;
    lng: number | null;
    categoryKeys: string[];
    isOpen?: boolean;
  }): Promise<void>;
}

export const DISCOVERY_PORT = Symbol('DISCOVERY_PORT');
