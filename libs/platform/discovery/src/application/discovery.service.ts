import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '@justgo/kernel';
import type { DiscoveryPort } from '../contract/discovery.port';
import type {
  DirectoryPage,
  DirectoryQuery,
  DirectorySupplierDTO,
  NearbyQuery,
  NearbySupplierDTO,
} from '../contract/dto';
import { PgDiscoveryRepository } from '../infra/pg-discovery.repository';

export const DISCOVERY_REPOSITORY = Symbol('DISCOVERY_REPOSITORY');
const DEFAULT_RADIUS_M = 10_000;
const MAX_RADIUS_M = 100_000;
const MAX_LIMIT = 100;
const DEFAULT_DIRECTORY_LIMIT = 25;

@Injectable()
export class DiscoveryService implements DiscoveryPort {
  constructor(@Inject(DISCOVERY_REPOSITORY) private readonly repo: PgDiscoveryRepository) {}

  async nearby(query: NearbyQuery): Promise<NearbySupplierDTO[]> {
    if (Math.abs(query.lat) > 90 || Math.abs(query.lng) > 180) {
      throw new ValidationError('lat/lng out of range');
    }
    const radiusM = Math.min(query.radiusM ?? DEFAULT_RADIUS_M, MAX_RADIUS_M);
    const limit = Math.min(query.limit ?? 50, MAX_LIMIT);
    return this.repo.nearby(query, radiusM, limit);
  }

  /**
   * Directory browse.
   *
   * Unlike `nearby`, this does NOT default a radius when a location is
   * given: a directory search for "body shops in Alger" should not drop a
   * result because it sits 11km away. Location here only ranks; it never
   * filters.
   */
  async directory(query: DirectoryQuery): Promise<DirectoryPage> {
    if (query.lat !== undefined && Math.abs(query.lat) > 90) {
      throw new ValidationError('lat out of range');
    }
    if (query.lng !== undefined && Math.abs(query.lng) > 180) {
      throw new ValidationError('lng out of range');
    }
    // One coordinate alone cannot rank anything, and silently ignoring it
    // would look like the sort was broken.
    if ((query.lat === undefined) !== (query.lng === undefined)) {
      throw new ValidationError('lat and lng must be provided together');
    }

    const limit = Math.min(query.limit ?? DEFAULT_DIRECTORY_LIMIT, MAX_LIMIT);
    const { rows, hasMore } = await this.repo.directory(query, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      // A cursor is only meaningful on the name-ordered path; the geo path
      // ranks by distance, where a (name, id) keyset would skip rows.
      nextCursor: hasMore && last && query.lat === undefined ? this.repo.cursorFor(last) : null,
    };
  }

  async getSupplier(supplierId: string): Promise<DirectorySupplierDTO | null> {
    return this.repo.getSupplier(supplierId);
  }

  async indexSupplier(input: {
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
  }): Promise<void> {
    await this.repo.upsert({ ...input, isOpen: input.isOpen ?? true });
  }
}
