import { Inject, Injectable } from '@nestjs/common';
import { ValidationError, type AccountId, type SupplierId } from '@justgo/kernel';
import type { AssistancePort } from '../contract/assistance.port';
import type {
  AssistanceChargeDTO,
  AssistanceRequestDTO,
  CreateAssistanceDTO,
} from '../contract/dto';
import { PgAssistanceRepository } from '../infra/pg-assistance.repository';

export const ASSISTANCE_REPOSITORY = Symbol('ASSISTANCE_REPOSITORY');

/**
 * Money, checked before it can reach a facture.
 *
 * Integer minor units and a three-letter currency (17.4 - no floats near
 * a total). Zero is allowed and records a call-out done for nothing; it
 * issues no facture.
 */
function validCharge(charge: AssistanceChargeDTO | undefined): AssistanceChargeDTO | undefined {
  if (charge === undefined) return undefined;
  if (!Number.isSafeInteger(charge.amountMinor) || charge.amountMinor < 0) {
    throw new ValidationError('amountMinor must be a non-negative integer in minor units', {
      amountMinor: charge.amountMinor,
    });
  }
  if (!/^[A-Z]{3}$/.test(charge.currency)) {
    throw new ValidationError('currency must be a 3-letter ISO 4217 code', {
      currency: charge.currency,
    });
  }
  return charge;
}

@Injectable()
export class AssistanceService implements AssistancePort {
  constructor(@Inject(ASSISTANCE_REPOSITORY) private readonly repo: PgAssistanceRepository) {}

  request(clientAccountId: AccountId, input: CreateAssistanceDTO): Promise<AssistanceRequestDTO> {
    if (input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) {
      throw new ValidationError('lat/lng out of range');
    }
    return this.repo.create(clientAccountId, input);
  }

  listForClient(clientAccountId: AccountId, limit = 50): Promise<AssistanceRequestDTO[]> {
    return this.repo.listForClient(clientAccountId, Math.min(limit, 200));
  }

  cancel(clientAccountId: AccountId, id: string): Promise<AssistanceRequestDTO> {
    return this.repo.transition(id, 'cancelled', { clientAccountId });
  }

  accept(supplierId: SupplierId, id: string): Promise<AssistanceRequestDTO> {
    return this.repo.transition(id, 'dispatched', { supplierId, assign: true });
  }

  advance(
    supplierId: SupplierId,
    id: string,
    to: 'en_route' | 'completed',
    charge?: AssistanceChargeDTO,
  ): Promise<AssistanceRequestDTO> {
    return this.repo.transition(id, to, { supplierId }, validCharge(charge));
  }

  charge(
    supplierId: SupplierId,
    id: string,
    input: AssistanceChargeDTO,
  ): Promise<AssistanceRequestDTO> {
    return this.repo.charge(supplierId, id, validCharge(input) as AssistanceChargeDTO);
  }
}
