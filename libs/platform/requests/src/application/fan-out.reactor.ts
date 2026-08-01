import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { asId, type RequestId, type SupplierId } from '@justgo/kernel';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import {
  SUPPLIER_TARGETING_PORT,
  VerticalRegistry,
  type SupplierTargetingPort,
} from '@justgo/contracts';
import { REQUEST_SUBMITTED, type RequestSubmittedV1 } from '../contract/events';
import { REQUESTS_PORT, type RequestsPort } from '../contract/requests.port';

/**
 * The Quote Engine's fan-out (§9, §13). Subscribes to RequestSubmitted and
 * creates a quote stub per targeted supplier — NEVER on the HTTP request
 * path (§17.4). Targeting is capability-driven: the core asks the registry
 * which verticals RECEIVE_PART_REQUESTS and never names one.
 *
 * Idempotent: fanOut() upserts on (request_id, supplier_id), so
 * at-least-once redelivery is harmless.
 */
@Injectable()
export class FanOutReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(FanOutReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(REQUESTS_PORT) private readonly requests: RequestsPort,
    private readonly verticals: VerticalRegistry,
    @Optional()
    @Inject(SUPPLIER_TARGETING_PORT)
    private readonly targeting: SupplierTargetingPort | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(REQUEST_SUBMITTED, (event) => this.handle(event));
  }

  async handle(event: DomainEvent): Promise<void> {
    if (!this.targeting) {
      this.logger.warn('No SupplierTargetingPort wired — skipping fan-out');
      return;
    }
    const payload = event.payload as RequestSubmittedV1;

    const verticalKeys = this.verticals
      .withCapability('RECEIVES_PART_REQUESTS')
      .map((v) => v.key);

    const supplierIds = await this.targeting.targetsFor({
      verticalKeys,
      categoryKey: payload.categoryKey,
      targetSupplierId:
        payload.strategy === 'single' ? (payload.targetSupplierId ?? undefined) : undefined,
    });

    const created = await this.requests.fanOut(
      asId<RequestId>(payload.requestId),
      supplierIds.map((id) => asId<SupplierId>(id)),
    );
    this.logger.log(
      `request ${payload.requestId}: fanned out to ${created} supplier(s) across ${verticalKeys.length} vertical(s)`,
    );
  }
}
