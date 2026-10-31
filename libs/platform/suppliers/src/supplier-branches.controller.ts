import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, NotFoundError, ValidationError, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { BRANCHES_PORT, SUPPLIERS_PORT, type BranchesPort, type SuppliersPort } from './contract/suppliers.port';
import type { BranchDTO } from './contract/dto';

const intervalSchema = z
  .object({
    from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();

// `partialRecord`, not `record` — see suppliers.controller.ts for why
// an enum-keyed Zod record would demand all seven weekdays.
const hoursSchema = z.partialRecord(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z.array(intervalSchema).max(4),
);

const createSchema = z
  .object({
    name: z.string().min(1).max(200),
    address: z.string().max(300).optional(),
    city: z.string().max(120).optional(),
    country: z.string().length(2).optional(),
    phone: z.string().max(32).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    hours: hoursSchema.optional(),
    isOpen: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    address: z.string().max(300).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    country: z.string().length(2).nullable().optional(),
    phone: z.string().max(32).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    hours: hoursSchema.nullable().optional(),
    isOpen: z.boolean().optional(),
  })
  .strict();

const listSchema = z.object({ includeClosed: z.coerce.boolean().optional() });

/**
 * Branches of a multi-site business (§15 supplier/business).
 *
 * `suppliers.branches` and `is_multi_branch` have existed since the first
 * schema, and `POST /v1/auth/session` has always accepted a `branchId` —
 * for a branch that nothing could create. This is the missing half.
 *
 * Every route resolves the business FROM THE CALLER, so a branch of another
 * supplier is not addressable from here at all.
 */
@Controller('supplier/branches')
export class SupplierBranchesController {
  constructor(
    @Inject(BRANCHES_PORT) private readonly branches: BranchesPort,
    @Inject(SUPPLIERS_PORT) private readonly suppliers: SuppliersPort,
  ) {}

  /**
   * A supplier-scoped session already names the business; a plain owner
   * session does not, so fall back to the one this account owns. Both paths
   * end at an id the caller demonstrably controls.
   */
  private async callerSupplier(auth: AuthContext): Promise<SupplierId> {
    if (auth.supplierScope?.supplierId) return auth.supplierScope.supplierId;
    const supplier = await this.suppliers.getByOwner(auth.accountId as AccountId);
    if (!supplier) throw new NotFoundError('Supplier');
    return supplier.id;
  }

  @Get()
  @RequirePermissions('supplier.profile.manage')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<{ items: BranchDTO[] }> {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query', { issues: parsed.error.issues });
    }
    const supplierId = await this.callerSupplier(auth);
    return { items: await this.branches.list(supplierId, parsed.data) };
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('supplier.profile.manage')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<BranchDTO> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid branch', { issues: parsed.error.issues });
    }
    const supplierId = await this.callerSupplier(auth);
    return this.branches.create(supplierId, parsed.data);
  }

  @Patch(':id')
  @RequirePermissions('supplier.profile.manage')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BranchDTO> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid branch patch', { issues: parsed.error.issues });
    }
    const supplierId = await this.callerSupplier(auth);
    return this.branches.update(supplierId, asId<Uuid>(id), parsed.data);
  }

  /**
   * Close a branch. Soft, like closing a business: a session token issued
   * earlier can already carry this branch id, and products reference it.
   */
  @Delete(':id')
  @RequirePermissions('supplier.profile.manage')
  async close(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<BranchDTO> {
    const supplierId = await this.callerSupplier(auth);
    return this.branches.close(supplierId, asId<Uuid>(id));
  }
}
