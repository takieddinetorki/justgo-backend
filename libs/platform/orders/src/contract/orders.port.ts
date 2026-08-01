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
  changeStatus(orderId: OrderId, status: OrderStatus): Promise<OrderDTO>;
}

export const ORDERS_PORT = Symbol('ORDERS_PORT');
