import type { DomainEvent } from './domain-event';

export type EventHandler = (event: DomainEvent) => Promise<void>;

export interface Subscription {
  unsubscribe(): Promise<void>;
}

/**
 * The bus port (§12). In the monolith this is BullMQ; when a module is
 * extracted the same events flow over the network with identical payloads.
 * Delivery is at-least-once: handlers MUST be idempotent (dedupe on event id).
 */
export interface EventBus {
  publish(events: DomainEvent[]): Promise<void>;
  /** `type` is an exact event type, or '*' for all events. */
  subscribe(type: string, handler: EventHandler): Promise<Subscription>;
  close(): Promise<void>;
}

export const EVENT_BUS = Symbol('EVENT_BUS');
