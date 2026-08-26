import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { asId, type AccountId, type SupplierId } from '@justgo/kernel';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import { requestChannel } from '@justgo/realtime';
import { NOTIFICATIONS_PORT, type NotificationsPort } from '../contract/notifications.port';
import type { NotifyInput } from '../contract/dto';
import * as E from './consumed-events';

const account = (id: string): { account: AccountId } => ({ account: asId<AccountId>(id) });
const supplier = (id: string): { supplier: SupplierId } => ({ supplier: asId<SupplierId>(id) });

/**
 * Translates domain events (§12) into notifications (§13). Subscribes on
 * bootstrap; handlers are idempotent enough for at-least-once delivery —
 * a duplicate at worst writes a duplicate feed row, never corrupts state.
 * Each maps to one or more notify() calls; notify() persists then dispatches
 * across the pluggable channels (in-app + realtime + push).
 */
@Injectable()
export class NotificationReactors implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationReactors.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(NOTIFICATIONS_PORT) private readonly notifications: NotificationsPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const on = (type: string, fn: (e: DomainEvent) => Promise<void>) =>
      this.bus.subscribe(type, (e) => this.guard(type, e, fn));

    await on(E.USER_REGISTERED, (e) => this.onUserRegistered(e.payload as E.UserRegistered));
    await on(E.QUOTE_REQUESTED, (e) => this.onQuoteRequested(e.payload as E.QuoteRequested));
    await on(E.QUOTE_SUBMITTED, (e) => this.onQuoteSubmitted(e.payload as E.QuoteMoved));
    await on(E.QUOTE_ALTERNATIVE_OFFERED, (e) =>
      this.onQuoteAlternative(e.payload as E.QuoteAlternative),
    );
    await on(E.QUOTE_REJECTED, (e) => this.onQuoteRejected(e.payload as E.QuoteRejectedEvent));
    await on(E.QUOTE_ACCEPTED, (e) => this.onQuoteAccepted(e.payload as E.QuoteMoved));
    await on(E.ORDER_CREATED, (e) => this.onOrderCreated(e.payload as E.OrderCreated));
    await on(E.ORDER_STATUS_CHANGED, (e) =>
      this.onOrderStatusChanged(e.payload as E.OrderStatusChanged),
    );
  }

  private async guard(
    type: string,
    e: DomainEvent,
    fn: (e: DomainEvent) => Promise<void>,
  ): Promise<void> {
    try {
      await fn(e);
    } catch (error) {
      this.logger.error(`notification handler for ${type} failed: ${(error as Error).message}`);
    }
  }

  private notify(input: NotifyInput): Promise<unknown> {
    return this.notifications.notify(input);
  }

  private onUserRegistered(p: E.UserRegistered): Promise<void> {
    return this.notify({
      recipient: account(p.accountId),
      type: 'welcome',
      title: 'Welcome to JustGo',
      body: 'Your account is ready.',
    }).then(() => undefined);
  }

  private onQuoteRequested(p: E.QuoteRequested): Promise<void> {
    return this.notify({
      recipient: supplier(p.supplierId),
      type: 'request.received',
      title: 'New part request',
      body: p.freeText ?? p.categoryKey ?? 'A client is requesting a quote.',
      refId: p.requestId,
      data: { quoteId: p.quoteId, categoryKey: p.categoryKey, tecdocArticleId: p.tecdocArticleId },
    }).then(() => undefined);
  }

  private onQuoteSubmitted(p: E.QuoteMoved): Promise<void> {
    return this.notify({
      recipient: account(p.clientAccountId),
      type: 'quote.received',
      title: 'New quote received',
      refId: p.requestId,
      extraChannels: [requestChannel(p.requestId)],
      data: {
        quoteId: p.quoteId,
        supplierId: p.supplierId,
        amountMinor: p.amountMinor,
        currency: p.currency,
      },
    }).then(() => undefined);
  }

  private onQuoteAlternative(p: E.QuoteAlternative): Promise<void> {
    return this.notify({
      recipient: account(p.clientAccountId),
      type: 'quote.alternative',
      title: 'Alternative part offered',
      body: p.altName,
      refId: p.requestId,
      extraChannels: [requestChannel(p.requestId)],
      data: { quoteId: p.quoteId, supplierId: p.supplierId, altName: p.altName },
    }).then(() => undefined);
  }

  private onQuoteRejected(p: E.QuoteRejectedEvent): Promise<void> {
    return this.notify({
      recipient: account(p.clientAccountId),
      type: 'quote.rejected',
      title: 'A supplier declined',
      body: p.reason ?? undefined,
      refId: p.requestId,
      extraChannels: [requestChannel(p.requestId)],
      data: { quoteId: p.quoteId, supplierId: p.supplierId },
    }).then(() => undefined);
  }

  private onQuoteAccepted(p: E.QuoteMoved): Promise<void> {
    return this.notify({
      recipient: supplier(p.supplierId),
      type: 'quote.accepted',
      title: 'Your quote was accepted',
      refId: p.requestId,
      data: { quoteId: p.quoteId, amountMinor: p.amountMinor, currency: p.currency },
    }).then(() => undefined);
  }

  private async onOrderCreated(p: E.OrderCreated): Promise<void> {
    await Promise.all([
      this.notify({
        recipient: account(p.clientAccountId),
        type: 'order.created',
        title: 'Order created',
        refId: p.orderId,
        data: { supplierId: p.supplierId, amountMinor: p.amountMinor, currency: p.currency },
      }),
      this.notify({
        recipient: supplier(p.supplierId),
        type: 'order.created',
        title: 'You have a new order',
        refId: p.orderId,
        data: { amountMinor: p.amountMinor, currency: p.currency },
      }),
    ]);
  }

  private async onOrderStatusChanged(p: E.OrderStatusChanged): Promise<void> {
    await Promise.all([
      this.notify({
        recipient: account(p.clientAccountId),
        type: 'order.status',
        title: `Order ${p.to}`,
        refId: p.orderId,
        data: { from: p.from, to: p.to },
      }),
      this.notify({
        recipient: supplier(p.supplierId),
        type: 'order.status',
        title: `Order ${p.to}`,
        refId: p.orderId,
        data: { from: p.from, to: p.to },
      }),
    ]);
  }
}
