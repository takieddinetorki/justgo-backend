import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { NotFoundError, ValidationError, type AccountId } from '@justgo/kernel';
import { SUPPLIERS_PORT, type SuppliersPort } from './contract/suppliers.port';
import type { SupplierDTO } from './contract/dto';

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
}
