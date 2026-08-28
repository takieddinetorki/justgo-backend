import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, Public, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ValidationError } from '@justgo/kernel';
import { MARKETPLACE_PORT, type MarketplacePort } from './contract/marketplace.port';
import type { ListingDTO } from './contract/dto';

const money = z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) });

const createSchema = z
  .object({
    title: z.string().min(1).max(200),
    brand: z.string().max(80).optional(),
    model: z.string().max(80).optional(),
    year: z.number().int().min(1900).max(2100).optional(),
    mileageKm: z.number().int().nonnegative().optional(),
    amount: money.optional(),
    description: z.string().max(5000).optional(),
    photoUrls: z.array(z.string().url()).max(20).optional(),
    city: z.string().max(120).optional(),
    country: z.string().length(2).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .strict();

const contactSchema = z.object({ message: z.string().max(1000).optional() }).strict();

@Controller('marketplace/listings')
export class MarketplaceController {
  constructor(@Inject(MARKETPLACE_PORT) private readonly marketplace: MarketplacePort) {}

  @Public()
  @Get()
  async browse(
    @Query('brand') brand?: string,
    @Query('maxAmountMinor') maxAmountMinor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: ListingDTO[] }> {
    return {
      items: await this.marketplace.browse({
        brand,
        maxAmountMinor: maxAmountMinor ? Number(maxAmountMinor) : undefined,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  @Public()
  @Get(':id')
  async get(@Param('id') id: string): Promise<ListingDTO> {
    return this.marketplace.get(id);
  }

  @Post()
  @RequirePermissions('listing.publish')
  async publish(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ListingDTO> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid listing', { issues: parsed.error.issues });
    return this.marketplace.publish(auth.accountId, parsed.data);
  }

  @Post(':id/contact')
  @RequirePermissions('listing.contact')
  async contact(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ contacted: true }> {
    const parsed = contactSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid contact', { issues: parsed.error.issues });
    return this.marketplace.contact(auth.accountId, id, parsed.data.message);
  }
}
