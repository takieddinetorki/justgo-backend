import type { AccountId, OrderId, QuoteId, RequestId, SupplierId } from '@justgo/kernel';
import type { MoneyDTO } from '@justgo/contracts';

export type Fulfilment = 'home' | 'pickup' | 'carrier' | 'install';

export type OrderStatus = 'created' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';

export interface OrderDTO {
  id: OrderId;
  requestId: RequestId | null;
  quoteId: QuoteId | null;
  clientAccountId: AccountId;
  supplierId: SupplierId;
  fulfilment: Fulfilment;
  workshopSupplierId: SupplierId | null;
  appointmentAt: string | null;
  amount: MoneyDTO | null;
  status: OrderStatus;
  createdAt: string;
}

export interface CreateOrderFromQuoteDTO {
  requestId: RequestId;
  quoteId: QuoteId;
  clientAccountId: AccountId;
  supplierId: SupplierId;
  amount: MoneyDTO | null;
}
