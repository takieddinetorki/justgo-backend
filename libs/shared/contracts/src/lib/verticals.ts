import type { FormSchema } from './form-schema';
import type { PartRequestDTO, QuoteContext, QuoteDraft } from './dto';

/**
 * The capability model (§9). The platform core routes by capability and
 * NEVER names a concrete vertical (§17.4).
 */
export type Capability =
  | 'RECEIVES_PART_REQUESTS'
  | 'LISTS_PRODUCTS'
  | 'LISTS_VEHICLES'
  | 'OFFERS_BOOKABLE_SERVICES'
  | 'HAS_CALENDAR'
  | 'PROVIDES_DISPATCH'
  | 'PUBLISHES_POLICIES'
  | 'PUBLISHES_OFFERS'
  | 'HAS_DELIVERY'
  | 'HAS_BRANCHES'
  | 'HAS_DEALS'
  | 'BUYER_CONTACT'
  | 'B2B_PURCHASING'
  | 'HAS_LOCATION_ROUTING'
  | 'CUSTOM_PROFILE'
  | 'INSTALLS_PARTS';

/** What a product/vehicle catalogue looks like for a vertical. */
export interface CatalogueSpec {
  kind: 'parts' | 'vehicles';
  /** Category keys the vertical lists under (maps to catalogue.assembly_groups). */
  categoryKeys: string[];
}

/** Bookable-service configuration for a vertical. */
export interface ServiceSpec {
  /** Seed keys for catalogue.service_types owned by this vertical. */
  serviceTypeKeys: string[];
  requiresVehicle: boolean;
}

/** Dispatch configuration (roadside-style verticals). */
export interface DispatchSpec {
  /** Max dispatch radius suppliers of this vertical serve, in km. */
  maxRadiusKm: number;
  requiresLiveLocation: boolean;
}

/**
 * A supplier vertical plug-in. Adding a vertical = implement this, register
 * under the VERTICAL token, add seed rows. Zero core changes (§9).
 */
export interface SupplierVertical {
  /** Stable key, e.g. 'part_store', 'roadside', 'tire_center'. */
  key: string;
  capabilities: Capability[];
  onboardingSchema(): FormSchema;
  profileSchema(): FormSchema;
  /** Required iff RECEIVES_PART_REQUESTS is declared. */
  quoteFor?(ctx: QuoteContext, request: PartRequestDTO): Promise<QuoteDraft>;
  /** Required iff LISTS_PRODUCTS or LISTS_VEHICLES is declared. */
  catalogueSpec?(): CatalogueSpec;
  /** Required iff OFFERS_BOOKABLE_SERVICES is declared. */
  serviceSpec?(): ServiceSpec;
  /** Required iff PROVIDES_DISPATCH is declared. */
  dispatchSpec?(): DispatchSpec;
}

/** Nest multi-provider token every vertical registers under. */
export const VERTICAL = Symbol('VERTICAL');
