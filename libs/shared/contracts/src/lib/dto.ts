import type { AccountId, RequestId, SupplierId, VehicleId } from '@justgo/kernel';

/** Wire shape for money (§15): integer minor units + ISO-4217 code. */
export interface MoneyDTO {
  amountMinor: number;
  currency: string;
}

/** Cursor pagination envelope (§15). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Fan-out strategy for a part request (§7 requests.part_requests.strategy). */
export type RequestStrategy = 'all' | 'single';

/**
 * The part-request as seen by verticals when drafting a quote (§9).
 * Owned by the requests module; published here because it crosses boundaries.
 */
export interface PartRequestDTO {
  id: RequestId;
  clientAccountId: AccountId;
  vehicleId: VehicleId | null;
  tecdocArticleId: number | null;
  categoryKey: string | null;
  freeText: string | null;
  photoUrl: string | null;
  quantity: number;
  strategy: RequestStrategy;
  targetSupplierId: SupplierId | null;
  createdAt: string; // UTC ISO-8601
  expiresAt: string | null;
}

/** Context handed to a vertical's quoteFor() hook (§9). */
export interface QuoteContext {
  supplierId: SupplierId;
  branchId: string | null;
  locale: string;
}

/** A vertical's suggested prefill for a quote — never auto-submitted. */
export interface QuoteDraft {
  kind: 'price' | 'alternative';
  amount?: MoneyDTO;
  altName?: string;
  altReference?: string;
  altTecdocArticleId?: number;
  note?: string;
}
