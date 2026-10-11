import type {
  DirectoryPage,
  DirectoryQuery,
  DirectorySupplierDTO,
  NearbyQuery,
  NearbySupplierDTO,
} from './dto';

/** Public port of the discovery read model (§6.1). */
export interface DiscoveryPort {
  nearby(query: NearbyQuery): Promise<NearbySupplierDTO[]>;
  /** Services Directory: browse/search without requiring a location. */
  directory(query: DirectoryQuery): Promise<DirectoryPage>;
  /** One provider, for the public profile screen. Null when unknown or closed. */
  getSupplier(supplierId: string): Promise<DirectorySupplierDTO | null>;
  /** Upsert one supplier into the geo index (called by the event reactor). */
  indexSupplier(input: {
    supplierId: string;
    verticalKey: string;
    name: string;
    lat: number | null;
    lng: number | null;
    categoryKeys: string[];
    isOpen?: boolean;
    city?: string | null;
    country?: string | null;
    rating?: number | null;
  }): Promise<void>;
}

export const DISCOVERY_PORT = Symbol('DISCOVERY_PORT');
