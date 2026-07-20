import { newId, type EventId, type Uuid } from '@justgo/kernel';

/**
 * Domain event envelope (§12). Events are versioned and additive — a
 * breaking payload change requires a new `version`, never a mutation.
 */
export interface DomainEvent<TPayload = unknown> {
  /** Globally unique; consumers dedupe on this (at-least-once delivery). */
  id: EventId;
  /** e.g. 'requests.QuoteAccepted' — `<module>.<EventName>` */
  type: string;
  version: number;
  aggregateId: Uuid | null;
  occurredAt: string; // UTC ISO-8601
  payload: TPayload;
}

export function makeEvent<TPayload>(input: {
  type: string;
  payload: TPayload;
  aggregateId?: Uuid | null;
  version?: number;
  occurredAt?: Date;
}): DomainEvent<TPayload> {
  return {
    id: newId<EventId>(),
    type: input.type,
    version: input.version ?? 1,
    aggregateId: input.aggregateId ?? null,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    payload: input.payload,
  };
}
