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
  /** SHA-256 over the exact stored PDF bytes. Not printable — see below. */
  sha256: string;
  /**
   * The hash PRINTED on the document and carried by its QR, over the
   * document's content rather than over the rendered file: number, type,
   * issue instant, chain position and the payload it was rendered from.
   *
   * A file hash cannot appear inside the file it describes — printing it
   * would change the bytes it was taken over. This one is computable
   * before the PDF exists, and is just as sensitive to the content: one
   * comma in a line description changes it completely.
   *
   * Unique per document, enforced by a unique index, so two invoices
   * that say exactly the same thing still differ. null only on documents
   * issued before 2026-11-09, which carry their number in their QR.
   */
  contentHash: string | null;
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

/** Fiscal identity of the seller. Every field is legally required. */
export interface SellerIdentity {
  legalName: string;
  address: string | null;
  city: string | null;
  country: string | null;
  nif: string;
  nis: string;
  rc: string;
  taxArticle: string;
}

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  /** Unit price INCLUDING tax, minor units. See application/tax.ts. */
  unitTtcMinor: number;
}

export interface IssueInvoiceInput {
  subjectType: string;
  subjectId: string;
  issuedToAccountId: string;
  supplierId: string;
  seller: SellerIdentity;
  buyerName: string;
  buyerNif?: string | null;
  currency: string;
  lines: InvoiceLineInput[];
  /** Defaults to the Algerian standard rate. */
  tvaRatePercent?: number;
}
