import type { AccountId, SupplierId } from '@justgo/kernel';
import type { MoneyDTO } from '@justgo/contracts';

export type ListingStatus = 'draft' | 'published' | 'pending_review' | 'sold' | 'withdrawn';

export type FuelType = 'essence' | 'diesel' | 'gpl' | 'hybrid' | 'electric';
export type Transmission = 'manual' | 'automatic';
export type BodyType =
  | 'citadine'
  | 'berline'
  | 'break'
  | 'suv'
  | 'monospace'
  | 'utilitaire'
  | 'coupe'
  | 'cabriolet'
  | 'pickup';
export type VehicleCondition = 'new' | 'used' | 'damaged';

/** What a bid asked for, and what became of it. */
export type BidStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'superseded';
/** Where it fell against the seller's range when it was placed. */
export type BidStanding = 'below_range' | 'in_range' | 'above_range';

/** The descriptive fields a buyer filters and judges a car on. */
export interface VehicleSpecDTO {
  fuelType: FuelType | null;
  transmission: Transmission | null;
  bodyType: BodyType | null;
  colour: string | null;
  doors: number | null;
  engineHp: number | null;
  condition: VehicleCondition | null;
  /** *Dédouanée*. Null means the seller did not say, which is not the same as no. */
  isCustomsCleared: boolean | null;
  papersInOrder: boolean | null;
  ownerCount: number | null;
  accidentFree: boolean | null;
}

export interface ListingDTO extends VehicleSpecDTO {
  id: string;
  sellerAccountId: AccountId;
  supplierId: SupplierId | null;
  title: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  mileageKm: number | null;
  amount: MoneyDTO | null;
  description: string | null;
  photoUrls: string[];
  city: string | null;
  country: string | null;
  status: ListingStatus;
  createdAt: string;

  /**
   * Whether this listing takes offers. Safe to show anyone — it says that
   * bidding is open without saying what would be accepted.
   */
  acceptsOffers: boolean;

  /**
   * The seller's acceptance range. **Present only in the seller's own view**
   * and never on a public read: a buyer who learns the floor bids the floor,
   * and every offer above it that the seller would have received is lost.
   */
  offerRange?: OfferRangeDTO | null;
  /** Live bid count. Seller's view only, for the same reason. */
  pendingBidCount?: number;
}

export interface OfferRangeDTO {
  min: MoneyDTO;
  /** Absent means "anything from the floor up". */
  max: MoneyDTO | null;
}

export interface BidDTO {
  id: string;
  listingId: string;
  buyerAccountId: AccountId;
  amount: MoneyDTO;
  message: string | null;
  status: BidStatus;
  /**
   * Visible to the SELLER only. Telling a buyer their bid landed
   * `below_range` would hand them the floor by bisection.
   */
  standing?: BidStanding;
  declineReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface CreateListingDTO extends Partial<VehicleSpecDTO> {
  title: string;
  brand?: string;
  model?: string;
  year?: number;
  mileageKm?: number;
  amount?: MoneyDTO;
  description?: string;
  photoUrls?: string[];
  city?: string;
  country?: string;
  lat?: number;
  lng?: number;
  /**
   * Setting this opens bidding. Private to the seller.
   *
   * `currency` may be omitted, in which case it is taken from the asking
   * price — a seller who has already named one should not have to repeat it.
   */
  offerRange?: SetOfferRangeDTO;
}

export interface SetOfferRangeDTO {
  minMinor: number;
  maxMinor?: number;
  currency?: string;
}

export interface PlaceBidDTO {
  amount: MoneyDTO;
  message?: string;
}

export interface ListingQuery {
  brand?: string;
  model?: string;
  maxAmountMinor?: number;
  currency?: string;
  fuelType?: FuelType;
  transmission?: Transmission;
  bodyType?: BodyType;
  condition?: VehicleCondition;
  city?: string;
  minYear?: number;
  maxMileageKm?: number;
  /** Only listings taking offers. */
  acceptsOffers?: boolean;
  limit?: number;
}
