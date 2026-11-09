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
/**
 * What the genuine document SAYS, returned so a holder can compare it
 * with the paper in their hand.
 *
 * THIS IS THE ONLY DEFENCE AGAINST A COPIED CODE. A fingerprint printed
 * on paper proves that a document with that fingerprint exists — nothing
 * more. Whoever prints the page chooses what else is on it, so they can
 * lift a valid fingerprint off a 6 000 DZD facture and print it under a
 * 10 000 DZD one, and a verifier that answers only "authentic" confirms
 * the forgery. Returning the real figures is what turns the scan into a
 * check: 6 000 on the screen against 10 000 on the paper, and the
 * forgery is obvious to the person holding both.
 *
 * Returned ONLY when the lookup came from a fingerprint, never from a
 * document number. Numbers are sequential and guessable, so disclosing
 * content against one would let anybody walk a business's turnover.
 * A 256-bit fingerprint is not guessable: presenting one means you are
 * already holding the document, so the figures tell you nothing you
 * could not read off the page.
 */
export interface VerifiedContent {
  /** Total as issued, in integer minor units. */
  totalMinor: number | null;
  currency: string | null;
  /** Date only — the time of day is noise for a visual comparison. */
  issuedOn: string;
  /** The issuing business, by legal name. Already public on the page. */
  issuer: string | null;
  /** How many lines the real document has, so an added line shows up. */
  lineCount: number | null;
}

/** A single answer a client can render without deriving one itself. */
export type VerificationVerdict =
  /** No such document. */
  | 'not_found'
  /** Our own sealed copy fails its signature — our problem, and serious. */
  | 'compromised'
  /** A real document, and the file the caller sent is byte-for-byte it. */
  | 'file_matches'
  /** A real document, and the file the caller sent is NOT it. */
  | 'file_altered'
  /** A real document exists; nothing was supplied to check against it. */
  | 'exists_unchecked'
  /** A real document, but annulled. */
  | 'void';

export interface VerificationResult {
  found: boolean;
  /**
   * OUR SEALED COPY is intact and its signature verifies.
   *
   * NOT a statement about the caller's document. A copied fingerprint on
   * a forged page returns `authentic: true`, because the document it
   * points at really is authentic — the page is not. Render `verdict`,
   * or `message`; rendering this boolean alone puts a tick on forgeries.
   */
  authentic: boolean;
  /** The one field to branch on. */
  verdict: VerificationVerdict;
  /** True only when the caller supplied a file and it matched. */
  matchesSuppliedFile?: boolean;
  number?: string;
  type?: DocumentType;
  status?: DocumentStatus;
  issuedAt?: string;
  voidedAt?: string | null;
  voidReason?: string | null;
  /** Present on a fingerprint lookup. Compare it with the paper. */
  content?: VerifiedContent;
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
