import type { DomainEvent } from './domain-event';

/**
 * Transactional outbox port (§12). Every module owns an `outbox` table of
 * this shape in its own schema; state change + append happen in ONE
 * transaction. The relay publishes and marks rows published.
 */
export interface OutboxRecord {
  event: DomainEvent;
  publishedAt: string | null;
}

export interface OutboxStore {
  /** Schema/scope this store writes to, e.g. 'requests'. */
  readonly schema: string;
  append(events: DomainEvent[]): Promise<void>;
  /** Oldest-first unpublished events. */
  fetchUnpublished(limit: number): Promise<DomainEvent[]>;
  markPublished(eventIds: string[]): Promise<void>;
}

export const OUTBOX_STORE = Symbol('OUTBOX_STORE');
