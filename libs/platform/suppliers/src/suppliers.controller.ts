import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, NotFoundError, ValidationError, type AccountId, type SupplierId } from '@justgo/kernel';
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

/**
 * Images are (bucket, path), never URLs (§14), and the bucket is fixed:
 * `supplier-media`. Letting a client name the bucket would make this a
 * pointer into ANY private bucket we own — including `documents` and
 * `driver-documents` — and a supplier profile is a public page.
 */
const mediaRefSchema = z
  .object({
    bucket: z.literal('supplier-media'),
    path: z.string().min(1).max(300),
  })
  .strict();

const intervalSchema = z
  .object({
    from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();

/**
 * `partialRecord`, NOT `record`.
 *
 * In Zod 4 a record with an enum key is EXHAUSTIVE: `z.record(z.enum([…]))`
 * demands every weekday and rejects `{ mon: [...] }` with six
 * "expected array, received undefined" issues. A shop that publishes Monday
 * would have to publish all seven, and the 400 names days the caller never
 * mentioned — which reads as a server bug rather than a schema rule.
 * `partialRecord` keeps the key validation (so `lundi` is still refused)
 * and makes each day optional.
 */
const hoursSchema = z.partialRecord(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z.array(intervalSchema).max(4),
);

/**
 * `null` clears, absent leaves alone.
 *
 * `.strict()` matters more here than anywhere else in this controller: a
 * typo'd key in a PATCH that silently did nothing would have an owner
 * convinced they had changed their opening hours.
 */
const profilePatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    phone: z.string().max(32).nullable().optional(),
    email: z.string().email().max(200).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    country: z.string().length(2).nullable().optional(),
    address: z.string().max(300).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    isOpen: z.boolean().optional(),
    hours: hoursSchema.nullable().optional(),
    logo: mediaRefSchema.nullable().optional(),
    cover: mediaRefSchema.nullable().optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const verificationSchema = z
  .object({
    verified: z.boolean(),
    note: z.string().max(1000).optional(),
  })
  .strict();

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
   * `PATCH /v1/supplier/profile` — the edit pencil.
   *
   * The supplier is resolved FROM THE CALLER, never taken from the body:
   * there is deliberately no route that names which business to edit, so a
   * supplier id is not something an attacker can supply.
   *
   * Not here, and not by accident: the verified badge (awarded by JustGo),
   * the rating (earned from customers) and the vertical (which decides the
   * catalogue and the matching rules, so changing it is a re-registration).
   */
  @Patch('profile')
  @RequirePermissions('supplier.profile.manage')
  async updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SupplierDTO> {
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid profile patch', { issues: parsed.error.issues });
    }
    const supplier = await this.suppliers.getByOwner(auth.accountId as AccountId);
    if (!supplier) throw new NotFoundError('Supplier');

    /*
      An uploaded object must live under the caller's own namespace, the
      same rule the driver document flow applies. `POST /v1/media/uploads`
      prefixes every path with the account id, so a path that does not start
      with it was not issued to this caller — it is somebody else's object
      being claimed as this business's logo.
    */
    for (const ref of [parsed.data.logo, parsed.data.cover]) {
      if (ref && !ref.path.startsWith(`${auth.accountId}/`)) {
        throw new ValidationError('Image path must be within your own upload namespace');
      }
    }

    return this.suppliers.updateProfile(supplier.id, parsed.data);
  }

  /**
   * `DELETE /v1/supplier/profile` — close the business.
   *
   * A soft close. The row stays because orders, invoices, reservations and
   * reviews all point at it, and a gapless fiscal series may not reference
   * a seller that no longer exists. What goes away is visibility: closed
   * suppliers leave discovery, the directory and quote fan-out.
   */
  @Delete('profile')
  @RequirePermissions('supplier.profile.manage')
  async closeProfile(@CurrentAuth() auth: AuthContext): Promise<SupplierDTO> {
    const supplier = await this.suppliers.getByOwner(auth.accountId as AccountId);
    if (!supplier) throw new NotFoundError('Supplier');
    return this.suppliers.close(supplier.id);
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

  /**
   * `PATCH /v1/supplier/{id}/verification` — the blue check.
   *
   * JustGo decides this, which is the whole value of a badge: one the
   * subject can award itself tells a reader nothing. This is the ONLY route
   * that touches it, it names the supplier explicitly (unlike every other
   * write here, which resolves the business from the caller), and it is
   * behind `platform.admin`.
   *
   * Withdrawable, with `{"verified": false}`. A badge that could only ever
   * be granted would mean a business that lost its registration keeps the
   * mark that says we checked it.
   */
  @Patch(':id/verification')
  @RequirePermissions('platform.admin')
  async setVerification(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SupplierDTO> {
    const parsed = verificationSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid verification decision', { issues: parsed.error.issues });
    }
    return this.suppliers.setVerification(
      asId<SupplierId>(id),
      parsed.data,
      auth.accountId as AccountId,
    );
  }
}
