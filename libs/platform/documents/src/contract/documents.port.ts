import type { AccountId, Uuid } from '@justgo/kernel';
import type { DocumentDTO, IssueDocumentInput, VerificationResult } from './dto';

/**
 * Public port of the documents context (§6.1). Other modules render
 * nothing themselves — they hand over a payload and get back a sealed,
 * numbered, stored document.
 */
export interface DocumentsPort {
  issue(input: IssueDocumentInput): Promise<DocumentDTO>;
  /** A short-lived signed URL for the stored bytes. Never a public link. */
  downloadUrl(callerAccountId: AccountId, documentId: Uuid): Promise<string>;
  listForAccount(accountId: AccountId, limit?: number): Promise<DocumentDTO[]>;
  /** Public: re-hashes the stored object and checks the signature. */
  verifyByNumber(number: string, suppliedFile?: Uint8Array): Promise<VerificationResult>;
  /** Admin only. Leaves the stored bytes untouched. */
  voidDocument(input: { documentId: Uuid; voidedBy: AccountId; reason: string }): Promise<DocumentDTO>;
}

export const DOCUMENTS_PORT = Symbol('DOCUMENTS_PORT');
