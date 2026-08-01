import type { AccountId, QuoteId, RequestId, SupplierId } from '@justgo/kernel';
import type {
  OfferAlternativeDTO,
  PartRequestDetailDTO,
  QuoteDTO,
  SubmitQuoteDTO,
  SubmitRequestDTO,
} from './dto';

/** Client-side surface of the core loop (§6.1). */
export interface RequestsPort {
  submit(clientAccountId: AccountId, input: SubmitRequestDTO): Promise<PartRequestDetailDTO>;
  getForClient(clientAccountId: AccountId, requestId: RequestId): Promise<PartRequestDetailDTO>;
  listForClient(clientAccountId: AccountId, limit?: number): Promise<PartRequestDetailDTO[]>;
  cancel(clientAccountId: AccountId, requestId: RequestId): Promise<PartRequestDetailDTO>;
  acceptQuote(clientAccountId: AccountId, quoteId: QuoteId): Promise<PartRequestDetailDTO>;
  refuseQuote(clientAccountId: AccountId, quoteId: QuoteId, reason?: string): Promise<PartRequestDetailDTO>;
  /** Creates the quote stubs the fan-out worker targets (§13). */
  fanOut(requestId: RequestId, supplierIds: SupplierId[]): Promise<number>;
  /** Sweeps requests past expires_at → EXPIRED (§8.1). */
  expireDue(now?: Date): Promise<number>;
}

/** Supplier-side surface of the core loop (§6.1). */
export interface QuotesPort {
  inbox(supplierId: SupplierId, limit?: number): Promise<QuoteDTO[]>;
  submitPrice(supplierId: SupplierId, quoteId: QuoteId, input: SubmitQuoteDTO): Promise<QuoteDTO>;
  offerAlternative(supplierId: SupplierId, quoteId: QuoteId, input: OfferAlternativeDTO): Promise<QuoteDTO>;
  reject(supplierId: SupplierId, quoteId: QuoteId, reason?: string): Promise<QuoteDTO>;
}

export const REQUESTS_PORT = Symbol('REQUESTS_PORT');
export const QUOTES_PORT = Symbol('QUOTES_PORT');
