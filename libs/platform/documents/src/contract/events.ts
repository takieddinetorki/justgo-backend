/** Events emitted by documents (§12). Versioned and additive. */

export const DOCUMENT_ISSUED = 'documents.DocumentIssued';
export interface DocumentIssuedV1 {
  documentId: string;
  type: string;
  number: string;
  subjectType: string;
  subjectId: string;
  issuedToAccountId: string | null;
  sha256: string;
  issuedAt: string;
}

export const DOCUMENT_VOIDED = 'documents.DocumentVoided';
export interface DocumentVoidedV1 {
  documentId: string;
  number: string;
  voidedBy: string;
  reason: string;
  voidedAt: string;
}
