import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ForbiddenError } from '@justgo/kernel';
import { asId, ValidationError, type OrderId, type SupplierId } from '@justgo/kernel';
import { DOCUMENTS_PORT, type DocumentDTO, type DocumentsPort } from '@justgo/documents';
import { ORDERS_PORT, type OrdersPort } from './contract/orders.port';
import type { OrderDTO } from './contract/dto';

/**
 * The supplier's three moves. Named by ACTION rather than by target state so
 * the client does not have to know the state machine, and so a typo cannot
 * silently request a transition we never meant to expose — `cancelled` is
 * reachable only through its own endpoint, under its own permission.
 */
const ADVANCE: Record<string, 'confirmed' | 'in_progress' | 'completed'> = {
  confirm: 'confirmed',
  start: 'in_progress',
  complete: 'completed',
};

const statusSchema = z.object({ action: z.enum(['confirm', 'start', 'complete']) }).strict();

const cancelSchema = z.object({ reason: z.string().max(500).optional() }).strict();

const fulfilmentSchema = z
  .object({
    fulfilment: z.enum(['home', 'pickup', 'carrier', 'install']),
    workshopSupplierId: z.string().uuid().optional(),
    appointmentAt: z.string().datetime().optional(),
  })
  .strict();

@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    @Inject(DOCUMENTS_PORT) private readonly documents: DocumentsPort,
  ) {}

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

  /**
   * Advance the order. Supplier side only.
   *
   * COMPLETION IS WHAT ISSUES THE FACTURE. Until this endpoint existed every
   * order sat at `created` forever, which is why the invoice had to be issued
   * on creation instead.
   */
  @Patch(':id/status')
  @RequirePermissions('order.fulfil')
  async advance(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OrderDTO> {
    if (!auth.supplierScope) {
      throw new ForbiddenError('This endpoint requires a supplier-scoped token');
    }
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid status change', { issues: parsed.error.issues });
    }
    return this.orders.advanceAsSupplier(
      auth.supplierScope.supplierId,
      asId<OrderId>(id),
      ADVANCE[parsed.data.action],
    );
  }

  /**
   * The *bon de commande* for this order, as a sealed PDF.
   *
   * WHY THIS SHAPE. There is no endpoint that accepts document CONTENT, and
   * there will not be: a signature over client-supplied text would certify
   * nothing. The only input here is the order id — the server reads what the
   * document says out of its own tables. That is what keeps the seal worth
   * having while still letting the app ask for the document.
   *
   * Idempotent: a double tap returns the BC that already exists rather than
   * burning a second number out of a gapless series.
   */
  @Post(':id/purchase-order')
  @RequirePermissions('order.read')
  async purchaseOrder(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<DocumentDTO> {
    // Buyer-scoped read: a stranger gets 404 before any document is made.
    const order = await this.orders.getForClient(auth.accountId, asId<OrderId>(id));
    return this.documents.issueOnce({
      type: 'purchase_order',
      subjectType: 'order',
      subjectId: order.id,
      issuedToAccountId: order.clientAccountId,
      supplierId: order.supplierId,
      payload: {
        Commande: order.id,
        Client: order.clientAccountId,
        Fournisseur: order.supplierId,
        Livraison: order.fulfilment,
        'Rendez-vous': order.appointmentAt,
        Montant: order.amount,
        Statut: order.status,
      },
    });
  }

  /** Either party calls the sale off. 409 once the order is completed. */
  @Post(':id/cancel')
  @RequirePermissions('order.cancel')
  async cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OrderDTO> {
    const parsed = cancelSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid cancellation', { issues: parsed.error.issues });
    }
    // A supplier-scoped token cancels AS the supplier; anyone else as the buyer.
    return this.orders.cancel(
      auth.supplierScope
        ? { supplierId: auth.supplierScope.supplierId }
        : { clientAccountId: auth.accountId },
      asId<OrderId>(id),
    );
  }
}
