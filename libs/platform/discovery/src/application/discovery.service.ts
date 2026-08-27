import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '@justgo/kernel';
import type { DiscoveryPort } from '../contract/discovery.port';
import type { NearbyQuery, NearbySupplierDTO } from '../contract/dto';
import { PgDiscoveryRepository } from '../infra/pg-discovery.repository';

export const DISCOVERY_REPOSITORY = Symbol('DISCOVERY_REPOSITORY');
const DEFAULT_RADIUS_M = 10_000;
const MAX_RADIUS_M = 100_000;
const MAX_LIMIT = 100;

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

  async indexSupplier(input: {
    supplierId: string;
    verticalKey: string;
    name: string;
    lat: number | null;
    lng: number | null;
    categoryKeys: string[];
    isOpen?: boolean;
  }): Promise<void> {
    await this.repo.upsert({ ...input, isOpen: input.isOpen ?? true });
  }
}
