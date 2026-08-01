import type { AccountId, QuoteId, RequestId, SupplierId, VehicleId } from '@justgo/kernel';
import type { MoneyDTO, RequestStrategy } from '@justgo/contracts';
import type { QuoteStatus, RequestStatus } from './status';

export interface SubmitRequestDTO {
  vehicleId?: VehicleId;
  tecdocArticleId?: number;
  categoryKey?: string;
  freeText?: string;
  photoUrl?: string;
  quantity?: number;
  strategy: RequestStrategy;
  targetSupplierId?: SupplierId;
  /** Client-supplied dedupe key (§16 idempotency). */
  idempotencyKey?: string;
  /** Defaults to the module's configured window. */
  expiresInMinutes?: number;
}

export interface PartRequestDetailDTO {
  id: RequestId;
  clientAccountId: AccountId;
  vehicleId: VehicleId | null;
  tecdocArticleId: number | null;
  categoryKey: string | null;
  freeText: string | null;
  photoUrl: string | null;
  quantity: number;
  strategy: RequestStrategy;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string | null;
  quotes: QuoteDTO[];
  /** Lowest priced quote among `quoted`, same-currency (§8.1). */
  bestQuoteId: QuoteId | null;
}

export interface QuoteDTO {
  id: QuoteId;
  requestId: RequestId;
  supplierId: SupplierId;
  kind: 'price' | 'alternative' | null;
  amount: MoneyDTO | null;
  altName: string | null;
  altReference: string | null;
  altTecdocArticleId: number | null;
  status: QuoteStatus;
  reason: string | null;
  createdAt: string;
  /** True for the current best price — flagged for the client (§8.1). */
  isBest?: boolean;
}

export interface SubmitQuoteDTO {
  amount: MoneyDTO;
}

export interface OfferAlternativeDTO {
  altName: string;
  altReference?: string;
  altTecdocArticleId?: number;
  amount?: MoneyDTO;
}
