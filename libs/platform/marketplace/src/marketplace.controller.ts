import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentAuth, Public, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ValidationError } from '@justgo/kernel';
import { MARKETPLACE_PORT, type MarketplacePort } from './contract/marketplace.port';
import type { BidDTO, ListingDTO } from './contract/dto';

const money = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const FUEL = ['essence', 'diesel', 'gpl', 'hybrid', 'electric'] as const;
const TRANSMISSION = ['manual', 'automatic'] as const;
const BODY = [
  'citadine',
  'berline',
  'break',
  'suv',
  'monospace',
  'utilitaire',
  'coupe',
  'cabriolet',
  'pickup',
] as const;
const CONDITION = ['new', 'used', 'damaged'] as const;

/** The descriptive fields, shared by create and the browse filters. */
const specShape = {
  fuelType: z.enum(FUEL).optional(),
  transmission: z.enum(TRANSMISSION).optional(),
  bodyType: z.enum(BODY).optional(),
  colour: z.string().max(40).optional(),
  doors: z.number().int().min(1).max(9).optional(),
  engineHp: z.number().int().min(1).max(2000).optional(),
  condition: z.enum(CONDITION).optional(),
  isCustomsCleared: z.boolean().optional(),
  papersInOrder: z.boolean().optional(),
  ownerCount: z.number().int().nonnegative().optional(),
  accidentFree: z.boolean().optional(),
};

const rangeShape = {
  minMinor: z.number().int().nonnegative(),
  maxMinor: z.number().int().nonnegative().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
};

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
    ...specShape,
    offerRange: z
      .object({ ...rangeShape, currency: z.string().regex(/^[A-Z]{3}$/).optional() })
      .strict()
      .optional(),
  })
  .strict();

const browseSchema = z.object({
  brand: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  maxAmountMinor: z.coerce.number().int().nonnegative().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  fuelType: z.enum(FUEL).optional(),
  transmission: z.enum(TRANSMISSION).optional(),
  bodyType: z.enum(BODY).optional(),
  condition: z.enum(CONDITION).optional(),
  city: z.string().max(120).optional(),
  minYear: z.coerce.number().int().min(1900).max(2100).optional(),
  maxMileageKm: z.coerce.number().int().nonnegative().optional(),
  acceptsOffers: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const contactSchema = z.object({ message: z.string().max(1000).optional() }).strict();
const offerRangeSchema = z.object(rangeShape).strict();
const bidSchema = z.object({ amount: money, message: z.string().max(1000).optional() }).strict();

@Controller('marketplace/listings')
export class MarketplaceController {
  constructor(@Inject(MARKETPLACE_PORT) private readonly marketplace: MarketplacePort) {}

  @Public()
  @Get()
  async browse(@Query() query: unknown): Promise<{ items: ListingDTO[] }> {
    const parsed = browseSchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError('Invalid browse query', { issues: parsed.error.issues });
    }
    return { items: await this.marketplace.browse(parsed.data) };
  }

  /** The public view: no acceptance range, no bid count. */
  @Public()
  @Get(':id')
  async get(@Param('id') id: string): Promise<ListingDTO> {
    return this.marketplace.get(id);
  }

  /** The owner's view of their own listing, with the range and live bids. */
  @Get(':id/private')
  @RequirePermissions('listing.publish')
  async getAsSeller(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ListingDTO> {
    return this.marketplace.getAsSeller(auth.accountId, id);
  }

  @Post()
  @RequirePermissions('listing.publish')
  async publish(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ListingDTO> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid listing', { issues: parsed.error.issues });
    }
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
    if (!parsed.success) {
      throw new ValidationError('Invalid contact', { issues: parsed.error.issues });
    }
    return this.marketplace.contact(auth.accountId, id, parsed.data.message);
  }

  /**
   * Set the acceptance range, which is what opens bidding.
   *
   * PUT because it is one value the seller replaces, not a collection they add
   * to — moving the range twice leaves one range, and a client that retries a
   * timed-out request must not end up with something different.
   */
  @Put(':id/offer-range')
  @RequirePermissions('listing.publish')
  async setOfferRange(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ListingDTO> {
    const parsed = offerRangeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid offer range', { issues: parsed.error.issues });
    }
    return this.marketplace.setOfferRange(auth.accountId, id, parsed.data);
  }

  /** Close bidding. Bids already placed keep the standing they were given. */
  @Delete(':id/offer-range')
  @RequirePermissions('listing.publish')
  async clearOfferRange(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ListingDTO> {
    return this.marketplace.clearOfferRange(auth.accountId, id);
  }

  /**
   * Place an offer.
   *
   * Throttled below the default because each one can interrupt the seller, and
   * because repeated bids are how someone would hunt for the floor by
   * bisection. The response deliberately does not say where the bid landed.
   */
  @Post(':id/bids')
  @HttpCode(201)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @RequirePermissions('listing.bid')
  async placeBid(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BidDTO> {
    const parsed = bidSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid offer', { issues: parsed.error.issues });
    }
    return this.marketplace.placeBid(auth.accountId, id, parsed.data);
  }

  /** The seller sees every offer, best first. A buyer sees only their own. */
  @Get(':id/bids')
  @RequirePermissions('listing.bid')
  async listBids(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ items: BidDTO[] }> {
    return { items: await this.marketplace.listBids(auth.accountId, id) };
  }
}
