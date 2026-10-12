import { Body, Controller, Get, Inject, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { NotFoundError, ValidationError, type AccountId } from '@justgo/kernel';
import { SUPPLIERS_PORT, type SuppliersPort } from './contract/suppliers.port';
import type { SupplierDTO } from './contract/dto';

/**
 * Fiscal identity. Every field is what Algerian law requires on a
 * facture, which is why `documents` refuses to invoice a seller missing
 * any of them.
 */
const fiscalSchema = z
  .object({
    legalName: z.string().min(1).max(200).optional(),
    address: z.string().max(300).optional(),
    nif: z.string().min(4).max(40).optional(),
    nis: z.string().min(4).max(40).optional(),
    rc: z.string().min(2).max(40).optional(),
    taxArticle: z.string().min(2).max(40).optional(),
  })
  .strict();

const registerSchema = z
  .object({
    verticalKey: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    city: z.string().max(120).optional(),
    country: z.string().length(2).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng must be provided together',
  });

@Controller('supplier')
export class SuppliersController {
  constructor(@Inject(SUPPLIERS_PORT) private readonly suppliers: SuppliersPort) {}

  /** Business onboarding (§15 supplier/business). */
  @Post()
  @RequirePermissions()
  async register(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<SupplierDTO> {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid supplier registration', { issues: parsed.error.issues });
    }
    return this.suppliers.register(auth.accountId as AccountId, parsed.data);
  }

  @Get('profile')
  @RequirePermissions()
  async profile(@CurrentAuth() auth: AuthContext): Promise<SupplierDTO> {
    const supplier = await this.suppliers.getByOwner(auth.accountId as AccountId);
    if (!supplier) throw new NotFoundError('Supplier');
    return supplier;
  }

  /**
   * `PATCH /v1/supplier/fiscal` — the seller block printed on every
   * invoice. Owner-scoped: a supplier may only edit its own, and the
   * supplier is resolved from the caller rather than taken from the body.
   */
  @Patch('fiscal')
  @RequirePermissions('supplier.profile.manage')
  async updateFiscal(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SupplierDTO> {
    const parsed = fiscalSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid fiscal identity', { issues: parsed.error.issues });
    }
    const supplier = await this.suppliers.getByOwner(auth.accountId as AccountId);
    if (!supplier) throw new NotFoundError('Supplier');
    return this.suppliers.updateFiscalIdentity(supplier.id, parsed.data);
  }

}
