import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';
import type {
  CaseDTO,
  CaseMessageDTO,
  CasePage,
  CaseQuery,
  CaseStatus,
  FileCaseDTO,
} from './dto';

/**
 * Who is asking. Every read and write resolves access from this rather than
 * taking a bare id, because the same case is visible to three different
 * parties with three different views of it — and the claimant must never see
 * an internal ops note.
 */
export interface CaseActor {
  accountId: AccountId;
  /** Set when the caller holds a supplier scope. */
  supplierId?: SupplierId;
  /** True for `platform.admin`: reaches every case, sees internal notes. */
  isOps?: boolean;
}

/** Public port of the reclamations context (§6.1). */
export interface ReclamationsPort {
  file(claimant: AccountId, input: FileCaseDTO): Promise<CaseDTO>;
  /**
   * The cases this actor may see: their own as claimant, those against their
   * business as respondent, or everything for ops.
   */
  list(actor: CaseActor, query?: CaseQuery): Promise<CasePage>;
  get(actor: CaseActor, caseId: Uuid): Promise<CaseDTO | null>;

  /** Add to the thread. `internal` is ops-only and is refused otherwise. */
  postMessage(
    actor: CaseActor,
    caseId: Uuid,
    input: { body: string; internal?: boolean },
  ): Promise<CaseMessageDTO>;
  listMessages(actor: CaseActor, caseId: Uuid): Promise<CaseMessageDTO[]>;

  /**
   * Move the case. `resolution` is required by the state machine for any
   * state that closes it — a closed complaint that does not say why is
   * worse than an open one.
   */
  changeStatus(
    actor: CaseActor,
    caseId: Uuid,
    next: CaseStatus,
    resolution?: string,
  ): Promise<CaseDTO>;
}

export const RECLAMATIONS_PORT = Symbol('RECLAMATIONS_PORT');
