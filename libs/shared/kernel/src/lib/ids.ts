import { randomUUID } from 'node:crypto';
import { ValidationError } from './errors';

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

/**
 * Narrow a string to a branded id, or REJECT it as a client mistake.
 *
 * It throws ValidationError, not TypeError, because of where it is
 * actually called: every controller runs it on a path parameter, and a
 * path parameter comes from whoever typed the URL. A TypeError is
 * nobody's error but ours, so the exception filter — correctly — logged a
 * stack trace and answered 500. `GET /v1/suppliers/not-a-uuid/reviews`
 * therefore told the caller the server was broken, when the truth is
 * that the id is not an id. 400 says that, and says it without a stack
 * trace in the log for every bot that probes a URL.
 */
export function asId<T extends Uuid>(value: string): T {
  if (!isUuid(value)) throw new ValidationError(`Invalid id: ${value}`, { value });
  return value as T;
}
