import type { AccountId, OrderId, SupplierId } from '@justgo/kernel';
import type { CreateOrderFromQuoteDTO, Fulfilment, OrderDTO, OrderStatus } from './dto';

export interface OrdersPort {
  /** Idempotent on quoteId — safe under at-least-once event delivery (§12). */
  createFromAcceptedQuote(input: CreateOrderFromQuoteDTO): Promise<OrderDTO>;
  getForClient(clientAccountId: AccountId, orderId: OrderId): Promise<OrderDTO>;
  listForClient(clientAccountId: AccountId, limit?: number): Promise<OrderDTO[]>;
  listForSupplier(supplierId: SupplierId, limit?: number): Promise<OrderDTO[]>;
  chooseFulfilment(
    clientAccountId: AccountId,
    orderId: OrderId,
    input: { fulfilment: Fulfilment; workshopSupplierId?: SupplierId; appointmentAt?: string },
  ): Promise<OrderDTO>;
  /**
   * Supplier-driven fulfilment: confirm -> start -> complete.
   *
   * Restricted to the supplier on the order. `order.fulfil` is deliberately
   * not a client permission: a buyer able to mark their own order complete
   * could attest the one thing the status exists to attest — and, now that
   * completion issues the facture, could make a supplier invoice itself.
   */
  advanceAsSupplier(
    supplierId: SupplierId,
    orderId: OrderId,
    next: Extract<OrderStatus, 'confirmed' | 'in_progress' | 'completed'>,
  ): Promise<OrderDTO>;

  /** Either party calls the sale off. The state machine still refuses it once
   * the order is completed or already cancelled. */
  cancel(
    actor: { clientAccountId?: AccountId; supplierId?: SupplierId },
    orderId: OrderId,
  ): Promise<OrderDTO>;

  /** Unguarded transition, for reactors and ops. Not reachable over HTTP. */
  changeStatus(orderId: OrderId, status: OrderStatus): Promise<OrderDTO>;
}

export const ORDERS_PORT = Symbol('ORDERS_PORT');
