import type { AccountId, SupplierId } from '@justgo/kernel';
import type { AssistanceChargeDTO, AssistanceRequestDTO, CreateAssistanceDTO } from './dto';

export interface AssistancePort {
  request(clientAccountId: AccountId, input: CreateAssistanceDTO): Promise<AssistanceRequestDTO>;
  listForClient(clientAccountId: AccountId, limit?: number): Promise<AssistanceRequestDTO[]>;
  cancel(clientAccountId: AccountId, id: string): Promise<AssistanceRequestDTO>;
  /** Supplier claims/advances a request (dispatch is a §21 seam). */
  accept(supplierId: SupplierId, id: string): Promise<AssistanceRequestDTO>;
  advance(
    supplierId: SupplierId,
    id: string,
    to: 'en_route' | 'completed',
    charge?: AssistanceChargeDTO,
  ): Promise<AssistanceRequestDTO>;
  /** Price a completed call-out. Write-once, like reservations. */
  charge(supplierId: SupplierId, id: string, input: AssistanceChargeDTO): Promise<AssistanceRequestDTO>;
}

export const ASSISTANCE_PORT = Symbol('ASSISTANCE_PORT');
