import { Inject, Injectable } from '@nestjs/common';
import { BusinessRuleError, type QuoteId, type SupplierId } from '@justgo/kernel';
import type { QuotesPort } from '../contract/requests.port';
import type { OfferAlternativeDTO, QuoteDTO, SubmitQuoteDTO } from '../contract/dto';
import { PgRequestsRepository } from '../infra/pg-requests.repository';
import { REQUESTS_REPOSITORY } from './requests.service';

@Injectable()
export class QuotesService implements QuotesPort {
  constructor(@Inject(REQUESTS_REPOSITORY) private readonly repo: PgRequestsRepository) {}

  async inbox(supplierId: SupplierId, limit = 50): Promise<QuoteDTO[]> {
    return this.repo.inbox(supplierId, Math.min(limit, 200));
  }

  async submitPrice(
    supplierId: SupplierId,
    quoteId: QuoteId,
    input: SubmitQuoteDTO,
  ): Promise<QuoteDTO> {
    if (!Number.isSafeInteger(input.amount.amountMinor) || input.amount.amountMinor < 0) {
      throw new BusinessRuleError('INVALID_AMOUNT', 'Price must be a non-negative integer of minor units');
    }
    return this.repo.supplierTransition(supplierId, quoteId, 'submit_price', { price: input });
  }

  async offerAlternative(
    supplierId: SupplierId,
    quoteId: QuoteId,
    input: OfferAlternativeDTO,
  ): Promise<QuoteDTO> {
    return this.repo.supplierTransition(supplierId, quoteId, 'offer_alternative', {
      alternative: input,
    });
  }

  async reject(supplierId: SupplierId, quoteId: QuoteId, reason?: string): Promise<QuoteDTO> {
    return this.repo.supplierTransition(supplierId, quoteId, 'reject', { reason });
  }
}
