/**
 * Realtime channel management (§13). The platform publishes domain moments to
 * named channels; clients (Client & Supplier apps) subscribe to the channels
 * that concern them:
 *   - `request:{requestId}` — the client watching one request for new quotes
 *   - `supplier:{supplierId}` — a supplier watching its inbox for new requests
 *   - `account:{accountId}` — a user's personal notification stream
 * Delivery is best-effort and fire-and-forget: realtime is a nicety on top of
 * the durable feed, never the system of record.
 */
export interface RealtimePort {
  publish(channel: string, event: string, payload: Record<string, unknown>): Promise<void>;
}

export const REALTIME_PORT = Symbol('REALTIME_PORT');

export const requestChannel = (requestId: string): string => `request:${requestId}`;
export const supplierChannel = (supplierId: string): string => `supplier:${supplierId}`;
export const accountChannel = (accountId: string): string => `account:${accountId}`;
