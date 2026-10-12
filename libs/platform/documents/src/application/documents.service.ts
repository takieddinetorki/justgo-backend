import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AccountId,
  type Uuid,
} from '@justgo/kernel';
import { MEDIA_PORT, type MediaPort } from '@justgo/media';
import type { DocumentsPort } from '../contract/documents.port';
import type {
  DocumentDTO,
  DocumentType,
  IssueDocumentInput,
  VerificationResult,
} from '../contract/dto';
import { DOCUMENT_SIGNER, type DocumentSigner } from '../contract/signer.port';
import { PgDocumentsRepository } from '../infra/pg-documents.repository';
import { Ed25519DocumentSigner, sha256Hex } from '../infra/ed25519-signer';
import { renderDocument } from '../infra/pdf-renderer';

export const DOCUMENTS_REPOSITORY = Symbol('DOCUMENTS_REPOSITORY');
export const DOCUMENTS_CONFIG = Symbol('DOCUMENTS_CONFIG');

export interface DocumentsConfig {
  bucket: string;
  /** Base for the URL printed on every page, e.g. `https://api…/v1/documents/verify`. */
  verifyBaseUrl: string;
}

/** Short code per type — the first segment of the document number. */
const SERIES: Record<DocumentType, string> = {
  reservation_confirmation: 'RES',
  quotation: 'DEV',
  purchase_order: 'BC',
  invoice: 'FA',
  credit_note: 'AV',
  receipt: 'REC',
};

@Injectable()
export class DocumentsService implements DocumentsPort {
  constructor(
    @Inject(DOCUMENTS_REPOSITORY) private readonly repo: PgDocumentsRepository,
    @Inject(DOCUMENT_SIGNER) private readonly signer: DocumentSigner,
    @Inject(MEDIA_PORT) private readonly media: MediaPort,
    @Inject(DOCUMENTS_CONFIG) private readonly config: DocumentsConfig,
  ) {}

  async issue(input: IssueDocumentInput): Promise<DocumentDTO> {
    const series = SERIES[input.type];
    if (!series) throw new ValidationError(`Unknown document type "${input.type}"`);

    return this.repo.issue({
      ...input,
      series,
      year: new Date().getFullYear(),
      /*
        Render, seal and store run INSIDE the numbering transaction, so a
        failure anywhere here rolls the number back rather than burning it.
        A fiscal series may not have gaps.
      */
      render: async ({ number, issuedAt }) => {
        const pdf = await renderDocument({
          type: input.type,
          number,
          issuedAt,
          payload: input.payload,
          verifyUrl: `${this.config.verifyBaseUrl}/${number}`,
        });

        const sealed = await this.signer.seal(pdf);
        const path = `${input.type}/${issuedAt.getFullYear()}/${number}.pdf`;

        // Hash the bytes we are ABOUT TO STORE, not the ones we rendered:
        // an embedded-signature signer returns different bytes, and the
        // stored artefact is always what gets verified.
        await this.media.putObject({
          bucket: this.config.bucket,
          path,
          bytes: sealed.bytes,
          contentType: 'application/pdf',
        });

        return {
          bucket: this.config.bucket,
          path,
          bytes: sealed.bytes,
          sha256: sha256Hex(sealed.bytes),
          signature: sealed.signature ?? '',
          algo: sealed.algo,
          keyId: sealed.keyId,
          format: sealed.format,
        };
      },
    });
  }

  async downloadUrl(callerAccountId: AccountId, documentId: Uuid): Promise<string> {
    const doc = await this.repo.byId(documentId);
    if (!doc) throw new NotFoundError('Document', documentId);
    if (doc.issuedToAccountId !== callerAccountId) {
      // 404 rather than 403: a document id should not be confirmable by
      // someone it was not issued to.
      throw new NotFoundError('Document', documentId);
    }
    return this.media.createSignedDownloadUrl({ bucket: doc.bucket, path: doc.path });
  }

  async listForAccount(accountId: AccountId, limit = 50): Promise<DocumentDTO[]> {
    return this.repo.listForAccount(accountId, Math.min(limit, 100));
  }

  /**
   * Public verification.
   *
   * Answers two independent questions, and keeps them independent:
   *
   *   authentic — we issued exactly these bytes and nobody has altered
   *               them. Cryptographic. Permanent; a void never makes a
   *               document inauthentic.
   *   status    — whether it still stands. A registry lookup, revocable.
   *
   * Deliberately returns NO contents — no amounts, no parties beyond the
   * issuer. Document numbers are guessable and this endpoint is public.
   */
  async verifyByNumber(number: string, suppliedFile?: Uint8Array): Promise<VerificationResult> {
    const doc = await this.repo.byNumber(number);
    if (!doc) {
      return {
        found: false,
        authentic: false,
        message: 'No document with that number was ever issued by JustGo.',
      };
    }

    // Re-hash what is actually in the bucket — not what the row claims.
    // Trusting the stored hash would make the check circular.
    const stored = await this.media.getObject({ bucket: doc.bucket, path: doc.path });
    const storedHash = sha256Hex(stored);
    const untouched = storedHash === doc.sha256;
    const signatureValid = await this.signer.verify({
      bytes: stored,
      signature: doc.signature || null,
      keyId: doc.keyId,
      algo: doc.algo,
    });
    const authentic = untouched && signatureValid;

    const result: VerificationResult = {
      found: true,
      authentic,
      number: doc.number,
      type: doc.type,
      status: doc.status,
      issuedAt: doc.issuedAt,
      voidedAt: doc.voidedAt,
      voidReason: doc.voidReason,
      message: '',
    };

    if (suppliedFile) {
      result.matchesSuppliedFile = sha256Hex(suppliedFile) === doc.sha256;
    }

    result.message = describe(result);
    return result;
  }

  async voidDocument(input: {
    documentId: Uuid;
    voidedBy: AccountId;
    reason: string;
  }): Promise<DocumentDTO> {
    if (!input.reason || input.reason.trim().length < 3) {
      throw new ValidationError('Voiding a document requires a reason');
    }
    const voided = await this.repo.void({ ...input, reason: input.reason.trim() });
    if (!voided) {
      const existing = await this.repo.byId(input.documentId);
      if (!existing) throw new NotFoundError('Document', input.documentId);
      // Already void. Not an error worth failing a retry over, but it
      // must not silently look like a fresh void.
      throw new ForbiddenError('That document is already void', {
        voidedAt: existing.voidedAt,
      });
    }
    return voided;
  }
}

/** The sentence a human holding a printout actually needs. */
export function describe(r: VerificationResult): string {
  if (!r.found) return 'No document with that number was ever issued by JustGo.';
  if (!r.authentic) {
    return 'WARNING: this document does not match what JustGo issued under that number. Treat it as falsified.';
  }
  if (r.matchesSuppliedFile === false) {
    return 'A genuine document exists under this number, but the file you supplied is NOT it. Your copy has been altered.';
  }
  if (r.status === 'void') {
    return `This document was genuinely issued by JustGo but was annulled on ${(r.voidedAt ?? '').slice(0, 10)}. It is no longer valid.`;
  }
  return 'Authentic and valid: issued by JustGo and unaltered.';
}

export { Ed25519DocumentSigner };
