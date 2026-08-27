import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { DISCOVERY_PORT, type DiscoveryPort } from '../contract/discovery.port';

/** suppliers.SupplierRegistered — consumed by name, not by importing suppliers. */
const SUPPLIER_REGISTERED = 'suppliers.SupplierRegistered';

interface SupplierRegisteredPayload {
  supplierId: string;
  verticalKey: string;
  name: string;
  lat?: number | null;
  lng?: number | null;
  categoryKeys?: string[];
}

/**
 * Builds the discovery geo index from suppliers events (§6.1). Idempotent:
 * indexSupplier upserts on supplier_id, so at-least-once redelivery is safe.
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
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as SupplierRegisteredPayload;
    await this.discovery.indexSupplier({
      supplierId: p.supplierId,
      verticalKey: p.verticalKey,
      name: p.name,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      categoryKeys: p.categoryKeys ?? [],
    });
    this.logger.log(`indexed supplier ${p.supplierId} (${p.verticalKey})`);
  }
}
