import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

export type DocumentType =
  | 'reservation_confirmation'
  | 'quotation'
  | 'purchase_order'
  | 'invoice'
  | 'credit_note'
  | 'receipt';

export type DocumentStatus = 'issued' | 'void';

export interface DocumentDTO {
  id: Uuid;
  type: DocumentType;
  /** Human reference, e.g. `RES-2026-000014`. Unique and gapless per series. */
  number: string;
  subjectType: string;
  subjectId: Uuid;
  issuedToAccountId: AccountId | null;
  supplierId: SupplierId | null;
  status: DocumentStatus;
  sha256: string;
  algo: string;
  keyId: string;
  signatureFormat: 'detached' | 'embedded';
  byteSize: number;
  issuedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface IssueDocumentInput {
  type: DocumentType;
  subjectType: string;
  subjectId: string;
  issuedToAccountId?: string;
  issuedByAccountId?: string;
  supplierId?: string;
  /**
   * Everything the document says, frozen. Rendered from this and stored
   * verbatim, so the document still reads correctly years after the
   * underlying rows have changed.
   */
  payload: Record<string, unknown>;
}

/**
 * The answer to "is this document real?".
 *
 * `authentic` and `status` are SEPARATE and both matter. A voided invoice
 * is still perfectly authentic — we did issue those exact bytes — it
 * simply no longer stands. Collapsing the two into one boolean is what
 * leads people to delete or regenerate files, destroying the audit trail
 * the system exists to provide.
 */
export interface VerificationResult {
  found: boolean;
  /** The signature checks out and the stored bytes are unaltered. */
  authentic: boolean;
  /** True only when the caller supplied a file and it matched. */
  matchesSuppliedFile?: boolean;
  number?: string;
  type?: DocumentType;
  status?: DocumentStatus;
  issuedAt?: string;
  voidedAt?: string | null;
  voidReason?: string | null;
  /** Plain-language summary for a human holding a printout. */
  message: string;
}
