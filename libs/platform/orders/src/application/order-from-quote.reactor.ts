import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { asId, type AccountId, type QuoteId, type RequestId, type SupplierId } from '@justgo/kernel';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { ORDERS_PORT, type OrdersPort } from '../contract/orders.port';

/** requests.QuoteAccepted — consumed by name, not by importing the module. */
const QUOTE_ACCEPTED = 'requests.QuoteAccepted';

interface QuoteAcceptedPayload {
  quoteId: string;
  requestId: string;
  supplierId: string;
  clientAccountId: string;
  amountMinor: number | null;
  currency: string | null;
}

/**
 * Turns an accepted quote into an order (§8.1 → §8.2). Idempotent: the
 * repository upserts on quote_id, so at-least-once redelivery is safe (§12).
 */
@Injectable()
export class OrderFromQuoteReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderFromQuoteReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(QUOTE_ACCEPTED, (event) => this.handle(event));
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as QuoteAcceptedPayload;
    const order = await this.orders.createFromAcceptedQuote({
      requestId: asId<RequestId>(p.requestId),
      quoteId: asId<QuoteId>(p.quoteId),
      clientAccountId: asId<AccountId>(p.clientAccountId),
      supplierId: asId<SupplierId>(p.supplierId),
      amount:
        p.amountMinor !== null && p.currency
          ? { amountMinor: p.amountMinor, currency: p.currency }
          : null,
    });
    this.logger.log(`quote ${p.quoteId} accepted → order ${order.id}`);
  }
}
