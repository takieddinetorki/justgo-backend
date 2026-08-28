import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ForbiddenError, ValidationError } from '@justgo/kernel';
import { PgCatalogRepository } from './infra/pg-catalog.repository';
import { CATALOG_REPOSITORY } from './application/catalog.tokens';
import type { ProductDTO, ServiceOfferDTO } from './contract/catalog-dto';

const money = z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) });

const productSchema = z
  .object({
    name: z.string().min(1).max(200),
    tecdocArticleId: z.number().int().positive().optional(),
    reference: z.string().max(120).optional(),
    categoryKey: z.string().max(64).optional(),
    amount: money.optional(),
    quantity: z.number().int().nonnegative().optional(),
    isDeal: z.boolean().optional(),
  })
  .strict();

const offerSchema = z
  .object({
    serviceTypeKey: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    amount: money.optional(),
    durationMins: z.number().int().positive().optional(),
  })
  .strict();

/** Supplier catalogue CRUD (§15 supplier — catalog: products/offers/deals). */
@Controller('supplier')
export class SupplierCatalogController {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly repo: PgCatalogRepository) {}

  private scope(auth: AuthContext) {
    if (!auth.supplierScope) throw new ForbiddenError('This endpoint requires a supplier-scoped token');
    return auth.supplierScope.supplierId;
  }

  @Get('products')
  @RequirePermissions('supplier.catalog.manage')
  async listProducts(@CurrentAuth() auth: AuthContext): Promise<{ items: ProductDTO[] }> {
    return { items: await this.repo.listProducts(this.scope(auth), false) };
  }

  @Get('deals')
  @RequirePermissions('supplier.catalog.manage')
  async listDeals(@CurrentAuth() auth: AuthContext): Promise<{ items: ProductDTO[] }> {
    return { items: await this.repo.listProducts(this.scope(auth), true) };
  }

  @Post('products')
  @RequirePermissions('supplier.catalog.manage')
  async createProduct(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ProductDTO> {
    const parsed = productSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid product', { issues: parsed.error.issues });
    return this.repo.createProduct(this.scope(auth), parsed.data);
  }

  @Patch('products/:id')
  @RequirePermissions('supplier.catalog.manage')
  async updateProduct(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProductDTO> {
    const parsed = productSchema.partial().safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid product patch', { issues: parsed.error.issues });
    return this.repo.updateProduct(this.scope(auth), id, parsed.data);
  }

  @Delete('products/:id')
  @RequirePermissions('supplier.catalog.manage')
  async deleteProduct(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<{ deleted: true }> {
    await this.repo.deleteProduct(this.scope(auth), id);
    return { deleted: true };
  }

  @Get('offers')
  @RequirePermissions('supplier.catalog.manage')
  async listOffers(@CurrentAuth() auth: AuthContext): Promise<{ items: ServiceOfferDTO[] }> {
    return { items: await this.repo.listOffers(this.scope(auth)) };
  }

  @Post('offers')
  @RequirePermissions('supplier.catalog.manage')
  async createOffer(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ServiceOfferDTO> {
    const parsed = offerSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid offer', { issues: parsed.error.issues });
    return this.repo.createOffer(this.scope(auth), parsed.data);
  }

  @Delete('offers/:id')
  @RequirePermissions('supplier.catalog.manage')
  async deleteOffer(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<{ deleted: true }> {
    await this.repo.deleteOffer(this.scope(auth), id);
    return { deleted: true };
  }
}
