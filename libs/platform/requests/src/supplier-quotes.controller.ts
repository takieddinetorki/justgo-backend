import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ForbiddenError, ValidationError, type QuoteId } from '@justgo/kernel';
import { QUOTES_PORT, type QuotesPort } from './contract/requests.port';
import type { QuoteDTO } from './contract/dto';

const moneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const priceSchema = z.object({ amount: moneySchema }).strict();

const alternativeSchema = z
  .object({
    altName: z.string().min(1).max(200),
    altReference: z.string().max(120).optional(),
    altTecdocArticleId: z.number().int().positive().optional(),
    amount: moneySchema.optional(),
  })
  .strict();

const rejectSchema = z.object({ reason: z.string().max(500).optional() }).strict();

/** Supplier inbox endpoints (§15 supplier — inbox). */
@Controller('supplier')
export class SupplierQuotesController {
  constructor(@Inject(QUOTES_PORT) private readonly quotes: QuotesPort) {}

  private supplierScope(auth: AuthContext) {
    if (!auth.supplierScope) {
      throw new ForbiddenError('This endpoint requires a supplier-scoped token');
    }
    return auth.supplierScope.supplierId;
  }

  @Get('requests')
  @RequirePermissions('supplier.requests.read')
  async inbox(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: QuoteDTO[] }> {
    const items = await this.quotes.inbox(this.supplierScope(auth), limit ? Number(limit) : 50);
    return { items };
  }

  @Post('requests/:quoteId/quote')
  @RequirePermissions('quote.submit')
  async price(
    @CurrentAuth() auth: AuthContext,
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
  ): Promise<QuoteDTO> {
    const parsed = priceSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid price quote', { issues: parsed.error.issues });
    }
    return this.quotes.submitPrice(this.supplierScope(auth), asId<QuoteId>(quoteId), parsed.data);
  }

  @Post('requests/:quoteId/alternative')
  @RequirePermissions('quote.submit')
  async alternative(
    @CurrentAuth() auth: AuthContext,
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
  ): Promise<QuoteDTO> {
    const parsed = alternativeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid alternative offer', { issues: parsed.error.issues });
    }
    return this.quotes.offerAlternative(
      this.supplierScope(auth),
      asId<QuoteId>(quoteId),
      parsed.data,
    );
  }

  @Post('requests/:quoteId/reject')
  @RequirePermissions('quote.submit')
  async reject(
    @CurrentAuth() auth: AuthContext,
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
  ): Promise<QuoteDTO> {
    const parsed = rejectSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid rejection', { issues: parsed.error.issues });
    }
    return this.quotes.reject(this.supplierScope(auth), asId<QuoteId>(quoteId), parsed.data.reason);
  }
}
