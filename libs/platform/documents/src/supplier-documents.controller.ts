import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ForbiddenError, ValidationError } from '@justgo/kernel';
import { DOCUMENTS_PORT, type DocumentsPort } from './contract/documents.port';
import type { DocumentDTO } from './contract/dto';

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    type: z
      .enum([
        'reservation_confirmation',
        'quotation',
        'purchase_order',
        'invoice',
        'credit_note',
        'receipt',
      ])
      .optional(),
  })
  .strict();

/**
 * `GET /v1/supplier/documents` — what this business has ISSUED.
 *
 * The gap this fills: `GET /v1/documents` answers by RECIPIENT, and a
 * business is not the recipient of its own facture. So every facture the
 * platform issued was listable and downloadable by the client, and
 * invisible to the supplier whose NIF, NIS, RC and article d'imposition
 * are printed on it. `supplier_id` had been written on every row since
 * migration 0020 and read by nothing.
 *
 * A facture is not a courtesy copy for the issuer. It is the document
 * that commits them, and the set of them is their sales ledger — the
 * thing an accountant asks for and the thing they are required to keep.
 *
 * Scoped to the token's own supplier, so there is no id to tamper with:
 * a business can only ever list its own. `?type=invoice` for factures
 * alone, which is the query a ledger screen actually makes.
 */
@Controller('supplier/documents')
export class SupplierDocumentsController {
  constructor(@Inject(DOCUMENTS_PORT) private readonly documents: DocumentsPort) {}

  @Get()
  @RequirePermissions('order.read')
  async issued(
    @CurrentAuth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<{ items: DocumentDTO[] }> {
    if (!auth.supplierScope) {
      throw new ForbiddenError('This endpoint requires a supplier-scoped token');
    }
    const parsed = querySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid document query', { issues: parsed.error.issues });
    }
    return {
      items: await this.documents.listForSupplier(
        auth.supplierScope.supplierId,
        parsed.data.limit,
        parsed.data.type,
      ),
    };
  }
}
