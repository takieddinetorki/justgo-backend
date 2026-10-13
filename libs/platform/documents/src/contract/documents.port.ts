import type { AccountId, Uuid } from '@justgo/kernel';
import type {
  DocumentDTO,
  IssueDocumentInput,
  IssueInvoiceInput,
  VerificationResult,
} from './dto';

/**
 * Public port of the documents context (§6.1). Other modules render
 * nothing themselves — they hand over a payload and get back a sealed,
 * numbered, stored document.
 */
export interface DocumentsPort {
  issue(input: IssueDocumentInput): Promise<DocumentDTO>;

  /**
   * Issue, or hand back the one that already exists for this subject.
   *
   * For documents a USER asks for — a bon de commande, a devis — where a
   * double tap must not burn a second number out of a gapless series. The
   * uniqueness is enforced by an index, not by the read this does first,
   * because two concurrent callers would both find nothing.
   */
  issueOnce(input: IssueDocumentInput): Promise<DocumentDTO>;
  /**
   * Issues a *facture*. Separate from `issue` because an invoice is a
   * tax document: it needs the seller's fiscal identifiers and priced
   * lines, and it REFUSES rather than emitting something that looks
   * official without them.
   */
  issueInvoice(input: IssueInvoiceInput): Promise<DocumentDTO>;
  /** A short-lived signed URL for the stored bytes. Never a public link. */
  downloadUrl(callerAccountId: AccountId, documentId: Uuid): Promise<string>;
  listForAccount(accountId: AccountId, limit?: number): Promise<DocumentDTO[]>;
  /** Public: re-hashes the stored object and checks the signature. */
  verifyByNumber(number: string, suppliedFile?: Uint8Array): Promise<VerificationResult>;
  /** Admin only. Leaves the stored bytes untouched. */
  voidDocument(input: { documentId: Uuid; voidedBy: AccountId; reason: string }): Promise<DocumentDTO>;
}

export const DOCUMENTS_PORT = Symbol('DOCUMENTS_PORT');
