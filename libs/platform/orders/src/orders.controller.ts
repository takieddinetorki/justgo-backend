import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ValidationError, type OrderId, type SupplierId } from '@justgo/kernel';
import { ORDERS_PORT, type OrdersPort } from './contract/orders.port';
import type { OrderDTO } from './contract/dto';

const fulfilmentSchema = z
  .object({
    fulfilment: z.enum(['home', 'pickup', 'carrier', 'install']),
    workshopSupplierId: z.string().uuid().optional(),
    appointmentAt: z.string().datetime().optional(),
  })
  .strict();

@Controller('orders')
export class OrdersController {
  constructor(@Inject(ORDERS_PORT) private readonly orders: OrdersPort) {}

  @Get()
  @RequirePermissions('order.read')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: OrderDTO[] }> {
    const items = auth.supplierScope
      ? await this.orders.listForSupplier(
          auth.supplierScope.supplierId,
          limit ? Number(limit) : 50,
        )
      : await this.orders.listForClient(auth.accountId, limit ? Number(limit) : 50);
    return { items };
  }

  @Get(':id')
  @RequirePermissions('order.read')
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<OrderDTO> {
    return this.orders.getForClient(auth.accountId, asId<OrderId>(id));
  }

  @Patch(':id/fulfilment')
  @RequirePermissions('order.create')
  async fulfilment(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OrderDTO> {
    const parsed = fulfilmentSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid fulfilment choice', { issues: parsed.error.issues });
    }
    const { workshopSupplierId, ...rest } = parsed.data;
    return this.orders.chooseFulfilment(auth.accountId, asId<OrderId>(id), {
      ...rest,
      workshopSupplierId: workshopSupplierId ? asId<SupplierId>(workshopSupplierId) : undefined,
    });
  }
}
