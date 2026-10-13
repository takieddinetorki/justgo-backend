import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, NotFoundError, ValidationError, type Uuid } from '@justgo/kernel';
import { DRIVERS_PORT, type DriversPort } from './contract/drivers.port';
import type { DriverDTO } from './contract/dto';

const applySchema = z
  .object({
    fullName: z.string().min(1).max(160),
    phone: z.string().max(32).optional(),
    licenceNumber: z.string().max(64).optional(),
    licenceExpiresOn: z.string().date().optional(),
    supplierId: z.string().uuid().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    fullName: z.string().min(1).max(160).optional(),
    phone: z.string().max(32).optional(),
    licenceNumber: z.string().max(64).optional(),
    licenceExpiresOn: z.string().date().optional(),
  })
  .strict();

const documentSchema = z
  .object({
    kind: z.enum(['licence_front', 'licence_back', 'selfie', 'id_card']),
    bucket: z.string().max(64),
    path: z.string().min(1).max(300),
  })
  .strict();

const availabilitySchema = z
  .object({
    isOnline: z.boolean(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .strict();

const decisionSchema = z
  .object({
    status: z.enum(['verified', 'rejected', 'suspended']),
    reason: z.string().max(1000).optional(),
  })
  .strict();

/**
 * Driver identity and verification (§15 driver + ops).
 *
 * THERE IS NO EARNINGS ENDPOINT, and that is deliberate rather than
 * unfinished. The app ships a DriverEarningsScreen, but earnings mean payouts
 * and payouts need the pricing, commission and capture model that spec §21
 * #3/#4 leaves open. A number invented here would be acted on by a real
 * driver and contradicted by the first real payout run, which is worse than
 * an empty screen. See docs/APP-BACKEND-GAP.md.
 */
@Controller('driver')
export class DriversController {
  constructor(@Inject(DRIVERS_PORT) private readonly drivers: DriversPort) {}

  /** Create the profile, or return the one this account already has. */
  @Post()
  @HttpCode(201)
  @RequirePermissions('driver.apply')
  async apply(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<DriverDTO> {
    const parsed = applySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid driver application', { issues: parsed.error.issues });
    }
    return this.drivers.apply(auth.accountId, parsed.data);
  }

  @Get('me')
  @RequirePermissions('driver.apply')
  async me(@CurrentAuth() auth: AuthContext): Promise<DriverDTO> {
    const found = await this.drivers.me(auth.accountId);
    if (!found) throw new NotFoundError('Driver', auth.accountId);
    return found;
  }

  @Patch('me')
  @RequirePermissions('driver.apply')
  async update(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<DriverDTO> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid update', { issues: parsed.error.issues });
    }
    return this.drivers.update(auth.accountId, parsed.data);
  }

  /**
   * Attach a licence photo, a selfie or an ID.
   *
   * Upload the image through `POST /v1/media/uploads` to the
   * `driver-documents` bucket first and send the returned path. Bytes never
   * pass through here, and a path outside your own upload namespace is
   * refused — submitting somebody else's licence is the one thing this flow
   * exists to prevent.
   *
   * Latest wins per kind, so retaking a photo replaces the old one.
   */
  @Post('me/documents')
  @RequirePermissions('driver.apply')
  async attach(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<DriverDTO> {
    const parsed = documentSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid document', { issues: parsed.error.issues });
    }
    return this.drivers.attachDocument(auth.accountId, parsed.data);
  }

  /** Submit for review. 422 naming the missing kinds if the set is short. */
  @Post('me/submit')
  @RequirePermissions('driver.apply')
  async submit(@CurrentAuth() auth: AuthContext): Promise<DriverDTO> {
    return this.drivers.submit(auth.accountId);
  }

  /** Go online or offline, with a position. Verified drivers only. */
  @Patch('me/availability')
  @RequirePermissions('driver.apply')
  async availability(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<DriverDTO> {
    const parsed = availabilitySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid availability', { issues: parsed.error.issues });
    }
    return this.drivers.setAvailability(auth.accountId, parsed.data);
  }

  /** The ops review queue, oldest submission first. */
  @Get('review')
  @RequirePermissions('platform.admin')
  async queue(@Query('limit') limit?: string): Promise<{ items: DriverDTO[] }> {
    return { items: await this.drivers.pendingReview(limit ? Number(limit) : 50) };
  }

  /** Ops decision. A refusal must carry a reason the driver can act on. */
  @Patch(':id/verification')
  @RequirePermissions('platform.admin')
  async decide(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DriverDTO> {
    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid decision', { issues: parsed.error.issues });
    }
    return this.drivers.decide({
      driverId: asId<Uuid>(id),
      status: parsed.data.status,
      reason: parsed.data.reason,
      decidedByAccountId: auth.accountId,
    });
  }
}
