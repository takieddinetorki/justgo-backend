import type { AccountId, SupplierId } from '@justgo/kernel';
import type { AssistanceRequestDTO, CreateAssistanceDTO } from './dto';

export interface AssistancePort {
  request(clientAccountId: AccountId, input: CreateAssistanceDTO): Promise<AssistanceRequestDTO>;
  listForClient(clientAccountId: AccountId, limit?: number): Promise<AssistanceRequestDTO[]>;
  cancel(clientAccountId: AccountId, id: string): Promise<AssistanceRequestDTO>;
  /** Supplier claims/advances a request (dispatch is a §21 seam). */
  accept(supplierId: SupplierId, id: string): Promise<AssistanceRequestDTO>;
  advance(supplierId: SupplierId, id: string, to: 'en_route' | 'completed'): Promise<AssistanceRequestDTO>;
}

export const ASSISTANCE_PORT = Symbol('ASSISTANCE_PORT');
