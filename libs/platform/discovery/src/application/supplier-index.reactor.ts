import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { DISCOVERY_PORT, type DiscoveryPort } from '../contract/discovery.port';

/** suppliers events — consumed by name, not by importing suppliers. */
const SUPPLIER_REGISTERED = 'suppliers.SupplierRegistered';
const SUPPLIER_UPDATED = 'suppliers.SupplierUpdated';

interface SupplierIndexPayload {
  supplierId: string;
  verticalKey: string;
  name: string;
  lat?: number | null;
  lng?: number | null;
  categoryKeys?: string[];
  // v2 of SupplierRegistered (§12). Absent on anything emitted before the
  // directory existed, which is why the upsert coalesces rather than
  // overwrites.
  city?: string | null;
  country?: string | null;
  rating?: number | null;
  // SupplierUpdated only: it reads them off the row it just wrote.
  isOpen?: boolean;
  isVerified?: boolean;
  ratingCount?: number;
}

/**
 * Builds the discovery read model from suppliers events (§6.1).
 *
 * TWO EVENT TYPES, ONE HANDLER. `SupplierRegistered` puts a business into
 * the index; `SupplierUpdated` keeps it current — it is emitted by a profile
 * edit, by a verification decision and by a rating recomputation alike. They
 * carry the same shape on purpose: a second handler would be a second chance
 * for the two to disagree about what the row now says.
 *
 * Idempotent: indexSupplier upserts on supplier_id, so at-least-once
 * redelivery is safe. Fields the event does not carry are left alone rather
 * than blanked — see the repository.
 */
@Injectable()
export class SupplierIndexReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplierIndexReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(DISCOVERY_PORT) private readonly discovery: DiscoveryPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(SUPPLIER_REGISTERED, (e) => this.handle(e));
    await this.bus.subscribe(SUPPLIER_UPDATED, (e) => this.handle(e));
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as SupplierIndexPayload;
    await this.discovery.indexSupplier({
      supplierId: p.supplierId,
      verticalKey: p.verticalKey,
      name: p.name,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      // `undefined`, not `[]`: the registry is the only source of category
      // coverage and a rating change has not consulted it. An empty array
      // here would erase what the index already holds.
      categoryKeys: p.categoryKeys ?? null,
      isOpen: p.isOpen ?? true,
      city: p.city ?? null,
      country: p.country ?? null,
      rating: p.rating ?? null,
      ratingCount: p.ratingCount ?? null,
      isVerified: p.isVerified ?? null,
    });
    this.logger.log(`indexed supplier ${p.supplierId} (${p.verticalKey})`);
  }
}
