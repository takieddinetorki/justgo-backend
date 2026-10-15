import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ValidationError } from '@justgo/kernel';
import { MARKETPLACE_PORT, type MarketplacePort } from './contract/marketplace.port';
import type { BidDTO } from './contract/dto';

const declineSchema = z.object({ reason: z.string().max(1000).optional() }).strict();

/**
 * Acting on one offer, by its own id.
 *
 * A separate controller from listings because the paths are not nested under a
 * listing: a bid id is unique on its own, and
 * `/listings/{id}/bids/{bidId}/accept` would make the client carry an id the
 * server does not need and could disagree with.
 */
@Controller('marketplace/bids')
export class BidsController {
  constructor(@Inject(MARKETPLACE_PORT) private readonly marketplace: MarketplacePort) {}

  /** Every offer this buyer has made, across listings. */
  @Get()
  @RequirePermissions('listing.bid')
  async mine(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: BidDTO[] }> {
    return { items: await this.marketplace.myBids(auth.accountId, limit ? Number(limit) : undefined) };
  }

  /** The buyer takes their offer back. 404 once it has been decided. */
  @Delete(':id')
  @RequirePermissions('listing.bid')
  async withdraw(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<BidDTO> {
    return this.marketplace.withdrawBid(auth.accountId, id);
  }

  /**
   * Accept it — which declines every other live offer on the listing, in the
   * same transaction. One car, one buyer.
   *
   * The listing status is NOT changed: a car sale here concludes with
   * paperwork days later, so marking it sold at the moment a price is agreed
   * would be a claim the seller then has to undo.
   */
  @Post(':id/accept')
  @RequirePermissions('listing.publish')
  async accept(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<BidDTO> {
    return this.marketplace.acceptBid(auth.accountId, id);
  }

  /** Decline it. A reason is optional — "no thanks" is a complete answer. */
  @Post(':id/decline')
  @RequirePermissions('listing.publish')
  async decline(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BidDTO> {
    const parsed = declineSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid decline', { issues: parsed.error.issues });
    }
    return this.marketplace.declineBid(auth.accountId, id, parsed.data.reason);
  }
}
