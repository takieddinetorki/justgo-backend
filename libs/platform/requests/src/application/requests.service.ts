import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessRuleError,
  type AccountId,
  type QuoteId,
  type RequestId,
  type SupplierId,
  CLOCK,
  type Clock,
} from '@justgo/kernel';
import type { RequestsPort } from '../contract/requests.port';
import type { PartRequestDetailDTO, QuoteDTO, SubmitRequestDTO } from '../contract/dto';
import { PgRequestsRepository } from '../infra/pg-requests.repository';

export const REQUESTS_REPOSITORY = Symbol('REQUESTS_REPOSITORY');
/** Default quote window; per-market tuning is an Open Question (§21.1). */
export const DEFAULT_EXPIRY_MINUTES = 60 * 24;

@Injectable()
export class RequestsService implements RequestsPort {
  constructor(
    @Inject(REQUESTS_REPOSITORY) private readonly repo: PgRequestsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async submit(
    clientAccountId: AccountId,
    input: SubmitRequestDTO,
  ): Promise<PartRequestDetailDTO> {
    // a request must describe the part somehow — catalogue id, category, or
    // free text (the TecDoc-outage fallback path, §10.5)
    if (!input.tecdocArticleId && !input.categoryKey && !input.freeText) {
      throw new BusinessRuleError(
        'REQUEST_UNDESCRIBED',
        'A request needs a catalogue article, a category, or free text',
      );
    }
    if (input.strategy === 'single' && !input.targetSupplierId) {
      throw new BusinessRuleError(
        'TARGET_SUPPLIER_REQUIRED',
        'strategy="single" requires targetSupplierId',
      );
    }
    const minutes = input.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES;
    const expiresAt = new Date(this.clock.now().getTime() + minutes * 60_000);
    return this.repo.submit(clientAccountId, input, expiresAt);
  }

  async getForClient(
    clientAccountId: AccountId,
    requestId: RequestId,
  ): Promise<PartRequestDetailDTO> {
    return this.repo.findForClient(clientAccountId, requestId);
  }

  async listForClient(clientAccountId: AccountId, limit = 50): Promise<PartRequestDetailDTO[]> {
    return this.repo.listForClient(clientAccountId, Math.min(limit, 200));
  }

  async cancel(clientAccountId: AccountId, requestId: RequestId): Promise<PartRequestDetailDTO> {
    return this.repo.cancel(clientAccountId, requestId);
  }

  async quoteForClient(clientAccountId: AccountId, quoteId: QuoteId): Promise<QuoteDTO> {
    return this.repo.quoteForClient(clientAccountId, quoteId);
  }

  async acceptQuote(clientAccountId: AccountId, quoteId: QuoteId): Promise<PartRequestDetailDTO> {
    return this.repo.acceptQuote(clientAccountId, quoteId);
  }

  async refuseQuote(
    clientAccountId: AccountId,
    quoteId: QuoteId,
    reason?: string,
  ): Promise<PartRequestDetailDTO> {
    return this.repo.refuseQuote(clientAccountId, quoteId, reason);
  }

  async fanOut(requestId: RequestId, supplierIds: SupplierId[]): Promise<number> {
    return this.repo.fanOut(requestId, supplierIds);
  }

  async expireDue(now?: Date): Promise<number> {
    return this.repo.expireDue(now ?? this.clock.now());
  }
}
