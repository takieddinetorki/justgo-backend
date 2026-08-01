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
}
