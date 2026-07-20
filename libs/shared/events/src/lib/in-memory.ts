import type { DomainEvent } from './domain-event';
import type { EventBus, EventHandler, Subscription } from './event-bus';
import type { OutboxStore } from './outbox';

/** In-process bus for unit tests and single-process dev. */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      const targets = [
        ...(this.handlers.get(event.type) ?? []),
        ...(this.handlers.get('*') ?? []),
      ];
      for (const handler of targets) await handler(event);
    }
  }

  async subscribe(type: string, handler: EventHandler): Promise<Subscription> {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return {
      unsubscribe: async () => {
        set.delete(handler);
      },
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

/** In-memory outbox for unit tests; mirrors the SQL table semantics. */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly rows: { event: DomainEvent; publishedAt: string | null }[] = [];

  constructor(readonly schema: string) {}

  async append(events: DomainEvent[]): Promise<void> {
    for (const event of events) this.rows.push({ event, publishedAt: null });
  }

  async fetchUnpublished(limit: number): Promise<DomainEvent[]> {
    return this.rows
      .filter((r) => r.publishedAt === null)
      .slice(0, limit)
      .map((r) => r.event);
  }

  async markPublished(eventIds: string[]): Promise<void> {
    const ids = new Set(eventIds);
    const now = new Date().toISOString();
    for (const row of this.rows) {
      if (ids.has(row.event.id)) row.publishedAt = now;
    }
  }

  /** Test helper. */
  unpublishedCount(): number {
    return this.rows.filter((r) => r.publishedAt === null).length;
  }
}
