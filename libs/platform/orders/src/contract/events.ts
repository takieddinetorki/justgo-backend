export const ORDER_CREATED = 'orders.OrderCreated';
export interface OrderCreatedV1 {
  orderId: string;
  requestId: string | null;
  quoteId: string | null;
  clientAccountId: string;
  supplierId: string;
  amountMinor: number | null;
  currency: string | null;
}

export const ORDER_STATUS_CHANGED = 'orders.OrderStatusChanged';
export interface OrderStatusChangedV1 {
  orderId: string;
  clientAccountId: string;
  supplierId: string;
  from: string;
  to: string;
  /**
   * The agreed price, carried on the event rather than looked up.
   *
   * Added when invoicing moved onto completion: the invoice reactor needs the
   * amount, and reaching back into orders to fetch it would couple documents
   * to this module (§4.7) for a value the event already knows. Events are
   * additive (§12), so an older consumer ignoring these is unaffected.
   */
  amountMinor: number | null;
  currency: string | null;
}
