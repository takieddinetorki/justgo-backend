import { ConflictError } from '@justgo/kernel';
import type { OrderStatus } from '../contract/dto';

/**
 * Order fulfilment lifecycle (§8.2):
 *   created → confirmed → in_progress → completed
 *   created|confirmed|in_progress → cancelled
 */
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  created: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function assertOrderTransition(current: OrderStatus, next: OrderStatus): OrderStatus {
  if (!ALLOWED[current].includes(next)) {
    throw new ConflictError(
      'ILLEGAL_ORDER_TRANSITION',
      `Cannot move an order from "${current}" to "${next}"`,
      { current, next, allowed: ALLOWED[current] },
    );
  }
  return next;
}

export function isTerminalOrder(status: OrderStatus): boolean {
  return ALLOWED[status].length === 0;
}
