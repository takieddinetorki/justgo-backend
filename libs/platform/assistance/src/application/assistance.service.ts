import { Inject, Injectable } from '@nestjs/common';
import { ValidationError, type AccountId, type SupplierId } from '@justgo/kernel';
import type { AssistancePort } from '../contract/assistance.port';
import type { AssistanceRequestDTO, CreateAssistanceDTO } from '../contract/dto';
import { PgAssistanceRepository } from '../infra/pg-assistance.repository';

export const ASSISTANCE_REPOSITORY = Symbol('ASSISTANCE_REPOSITORY');

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
  ): Promise<AssistanceRequestDTO> {
    return this.repo.transition(id, to, { supplierId });
  }
}
