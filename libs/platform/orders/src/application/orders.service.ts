import { Inject, Injectable } from '@nestjs/common';
import { BusinessRuleError, type AccountId, type OrderId, type SupplierId } from '@justgo/kernel';
import type { OrdersPort } from '../contract/orders.port';
import type {
  CreateOrderFromQuoteDTO,
  Fulfilment,
  OrderDTO,
  OrderStatus,
} from '../contract/dto';
import { PgOrdersRepository } from '../infra/pg-orders.repository';

export const ORDERS_REPOSITORY = Symbol('ORDERS_REPOSITORY');

@Injectable()
export class OrdersService implements OrdersPort {
  constructor(@Inject(ORDERS_REPOSITORY) private readonly repo: PgOrdersRepository) {}

  async createFromAcceptedQuote(input: CreateOrderFromQuoteDTO): Promise<OrderDTO> {
    return this.repo.createFromAcceptedQuote(input);
  }

  async getForClient(clientAccountId: AccountId, orderId: OrderId): Promise<OrderDTO> {
    return this.repo.findForClient(clientAccountId, orderId);
  }

  async listForClient(clientAccountId: AccountId, limit = 50): Promise<OrderDTO[]> {
    return this.repo.listForClient(clientAccountId, Math.min(limit, 200));
  }

  async listForSupplier(supplierId: SupplierId, limit = 50): Promise<OrderDTO[]> {
    return this.repo.listForSupplier(supplierId, Math.min(limit, 200));
  }

  async chooseFulfilment(
    clientAccountId: AccountId,
    orderId: OrderId,
    input: { fulfilment: Fulfilment; workshopSupplierId?: SupplierId; appointmentAt?: string },
  ): Promise<OrderDTO> {
    // §8.2: installation is only meaningful with a workshop appointment
    if (input.fulfilment === 'install' && !input.workshopSupplierId) {
      throw new BusinessRuleError(
        'WORKSHOP_REQUIRED',
        'Installation fulfilment requires a workshop supplier',
      );
    }
    return this.repo.setFulfilment(clientAccountId, orderId, input);
  }

  async advanceAsSupplier(
    supplierId: SupplierId,
    orderId: OrderId,
    next: Extract<OrderStatus, 'confirmed' | 'in_progress' | 'completed'>,
  ): Promise<OrderDTO> {
    return this.repo.changeStatus(orderId, next, { supplierId });
  }

  async cancel(
    actor: { clientAccountId?: AccountId; supplierId?: SupplierId },
    orderId: OrderId,
  ): Promise<OrderDTO> {
    if (!actor.clientAccountId && !actor.supplierId) {
      throw new BusinessRuleError('NOT_A_PARTY', 'Only a party to the order may cancel it');
    }
    return this.repo.changeStatus(orderId, 'cancelled', actor);
  }

  async changeStatus(orderId: OrderId, status: OrderStatus): Promise<OrderDTO> {
    return this.repo.changeStatus(orderId, status);
  }
}
