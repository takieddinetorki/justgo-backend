import { randomUUID } from 'node:crypto';

/**
 * Branded UUID types. All primary keys are UUIDs (§7); brands prevent
 * accidentally passing an AccountId where a SupplierId is expected.
 */
export type Uuid = string & { readonly __uuid: unique symbol };

export type Brand<B extends string> = Uuid & { readonly __brand: B };

export type AccountId = Brand<'AccountId'>;
export type SupplierId = Brand<'SupplierId'>;
export type BranchId = Brand<'BranchId'>;
export type VehicleId = Brand<'VehicleId'>;
export type RequestId = Brand<'RequestId'>;
export type QuoteId = Brand<'QuoteId'>;
export type OrderId = Brand<'OrderId'>;
export type ReservationId = Brand<'ReservationId'>;
export type EventId = Brand<'EventId'>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newId<T extends Uuid = Uuid>(): T {
  return randomUUID() as T;
}

export function isUuid(value: string): value is Uuid {
  return UUID_RE.test(value);
}

export function asId<T extends Uuid>(value: string): T {
  if (!isUuid(value)) throw new TypeError(`Invalid UUID: ${value}`);
  return value as T;
}
