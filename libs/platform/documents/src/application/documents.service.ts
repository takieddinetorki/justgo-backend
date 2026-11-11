import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { MEDIA_PORT, type MediaPort } from '@justgo/media';
import type { DocumentsPort } from '../contract/documents.port';
import type {
  DocumentActor,
  DocumentDTO,
  DocumentType,
  IssueDocumentInput,
  IssueInvoiceInput,
  VerificationResult,
  VerificationVerdict,
  VerifiedContent,
} from '../contract/dto';
import { DOCUMENT_SIGNER, type DocumentSigner } from '../contract/signer.port';
import { PgDocumentsRepository } from '../infra/pg-documents.repository';
import { Ed25519DocumentSigner, sha256Hex } from '../infra/ed25519-signer';
import { renderDocument } from '../infra/pdf-renderer';
import { renderInvoice } from '../infra/invoice-renderer';
import {
  documentContentHash,
  normaliseContentHash,
} from '../domain/content-hash';
import { TVA_STANDARD } from './tax';

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

  /**
   * Issue at most one document per subject.
   *
   * The read first keeps the common case cheap and gapless: no number is
   * reserved if the document already exists. The catch covers the race the
   * read cannot — two taps arriving together both see nothing, one wins the
   * unique index, and the loser returns the winner's document rather than a
   * 500 the client cannot act on.
   */
  async issueOnce(input: IssueDocumentInput): Promise<DocumentDTO> {
    const existing = await this.repo.bySubject(input.type, input.subjectType, input.subjectId);
    if (existing) return existing;

    try {
      return await this.issue(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('documents_one_per_subject')) throw error;

      const winner = await this.repo.bySubject(input.type, input.subjectType, input.subjectId);
      if (!winner) throw error; // the index fired for a reason we do not know
      return winner;
    }
  }

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
      render: async ({ number, prevSha256, issuedAt }) => {
        /*
          The hash is computed BEFORE the PDF, because it goes ON the PDF.
          That is the whole reason it is taken over the content rather
          than over the file: a file hash printed inside the file changes
          the file it describes.
        */
        const contentHash = documentContentHash({
          number,
          type: input.type,
          issuedAt,
          prevSha256,
          payload: input.payload,
        });
        const pdf = await renderDocument({
          type: input.type,
          number,
          issuedAt,
          payload: input.payload,
          contentHash,
          verifyUrl: `${this.config.verifyBaseUrl}/${contentHash}`,
          verifyBaseUrl: this.config.verifyBaseUrl,
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
          contentHash,
          signature: sealed.signature ?? '',
          algo: sealed.algo,
          keyId: sealed.keyId,
          format: sealed.format,
        };
      },
    });
  }

  /**
   * Issues a *facture*.
   *
   * REFUSES when the seller's fiscal identity is incomplete. An Algerian
   * invoice without NIF, NIS, RC and article d'imposition is not a valid
   * tax document, and emitting one anyway would hand the client
   * something that looks official, carries our seal, and is worthless —
   * a worse outcome than no invoice at all.
   */
  async issueInvoice(input: IssueInvoiceInput): Promise<DocumentDTO> {
    const missing = (['nif', 'nis', 'rc', 'taxArticle', 'legalName'] as const).filter(
      (k) => !input.seller[k] || String(input.seller[k]).trim() === '',
    );
    if (missing.length > 0) {
      throw new ValidationError(
        'Cannot issue an invoice: the seller’s fiscal identity is incomplete',
        { missing },
      );
    }
    if (input.lines.length === 0) {
      throw new ValidationError('An invoice needs at least one line');
    }

    const rate = input.tvaRatePercent ?? TVA_STANDARD;
    return this.repo.issue({
      type: 'invoice',
      series: SERIES.invoice,
      year: new Date().getFullYear(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      issuedToAccountId: input.issuedToAccountId,
      supplierId: input.supplierId,
      // Frozen: the seller's identifiers and the prices as they stood on
      // the day. An invoice must not change when a profile is edited.
      payload: { ...input, tvaRatePercent: rate },
      render: async ({ number, prevSha256, issuedAt }) => {
        // Over the frozen payload, so the printed hash covers exactly what
        // the facture says — including every line description and price.
        const contentHash = documentContentHash({
          number,
          type: 'invoice',
          issuedAt,
          prevSha256,
          payload: { ...input, tvaRatePercent: rate },
        });
        const pdf = await renderInvoice({
          number,
          issuedAt,
          currency: input.currency,
          seller: input.seller,
          buyer: { name: input.buyerName, nif: input.buyerNif ?? null },
          lines: input.lines,
          tvaRatePercent: rate,
          contentHash,
          verifyUrl: `${this.config.verifyBaseUrl}/${contentHash}`,
          verifyBaseUrl: this.config.verifyBaseUrl,
        });
        const sealed = await this.signer.seal(pdf);
        const path = `invoice/${issuedAt.getFullYear()}/${number}.pdf`;
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
          contentHash,
          signature: sealed.signature ?? '',
          algo: sealed.algo,
          keyId: sealed.keyId,
          format: sealed.format,
        };
      },
    });
  }

  /**
   * TWO parties may download a document, not one.
   *
   * The client it was issued to, obviously. And the business that issued
   * it, which used to be refused: a facture carries that business's NIF,
   * NIS, RC and article d'imposition, and the set of them is its sales
   * ledger. It was storing a `supplier_id` on every row and letting
   * nobody use it.
   *
   * Anyone else gets 404 rather than 403, because a document id should
   * not be confirmable by someone with no claim to it.
   */
  async downloadUrl(actor: DocumentActor, documentId: Uuid): Promise<string> {
    const doc = await this.repo.byId(documentId);
    if (!doc) throw new NotFoundError('Document', documentId);

    const isRecipient = doc.issuedToAccountId === actor.accountId;
    const isIssuer =
      actor.supplierId !== undefined &&
      doc.supplierId !== null &&
      doc.supplierId === actor.supplierId;
    if (!isRecipient && !isIssuer) throw new NotFoundError('Document', documentId);

    return this.media.createSignedDownloadUrl({ bucket: doc.bucket, path: doc.path });
  }

  async listForAccount(
    accountId: AccountId,
    limit = 50,
    type?: DocumentType,
  ): Promise<DocumentDTO[]> {
    return this.repo.listForAccount(accountId, Math.min(limit, 100), type);
  }

  async listForSupplier(
    supplierId: SupplierId,
    limit = 50,
    type?: DocumentType,
  ): Promise<DocumentDTO[]> {
    return this.repo.listForSupplier(supplierId, Math.min(limit, 100), type);
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
   *
   * ACCEPTS EITHER the content hash printed on the document — what its QR
   * carries, and what somebody types off the page — or the document
   * number. One route for both because they identify the same thing and
   * the answer is identical; a hash is simply the better key, being
   * unguessable and unique even between two documents that say the same
   * thing. Documents issued before content hashes existed have only a
   * number, and keep resolving by it.
   */
  async verifyByNumber(
    numberOrHash: string,
    suppliedFile?: Uint8Array,
  ): Promise<VerificationResult> {
    /*
      Tolerant about how the hash arrives: scanned, pasted, or typed in
      the spaced groups it is printed in. Anything that is not a 64-hex
      digest is treated as a document number.
    */
    const hash = normaliseContentHash(numberOrHash);
    const doc = hash ? await this.repo.byContentHash(hash) : await this.repo.byNumber(numberOrHash);
    if (!doc) {
      return {
        found: false,
        authentic: false,
        verdict: 'not_found',
        message: hash
          ? 'No document with that fingerprint was ever issued by JustGo.'
          : 'No document with that number was ever issued by JustGo.',
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
      verdict: 'exists_unchecked',
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

    /*
      The figures, but only to a caller who presented a FINGERPRINT.
      That is what makes a scan able to catch a copied code: the screen
      says what the real document says, and the holder compares it with
      the paper. Against a document NUMBER we disclose nothing — numbers
      are sequential, and content against one would let anybody walk a
      business's turnover.
    */
    if (hash) {
      result.content = summarise(doc);
      /*
        And where it points. A scanned confirmation is a navigation
        token as much as a seal: the supplier wants the booking, not a
        verdict. Only on a fingerprint, for the same reason as the
        figures above.
      */
      result.subject = { type: doc.subjectType, id: doc.subjectId };
    }

    result.verdict = decide(result);
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

/**
 * What the genuine document says, for comparison against the paper.
 *
 * Reads the frozen payload rather than anything live, so the figures are
 * the ones the document was issued with — which is the whole point.
 */
function summarise(doc: {
  type: string;
  issuedAt: string;
  payloadSnapshot: Record<string, unknown>;
}): VerifiedContent {
  const p = doc.payloadSnapshot ?? {};
  const lines = Array.isArray(p['lines']) ? (p['lines'] as Array<Record<string, unknown>>) : null;
  /*
    Recomputed from the lines, the same arithmetic the renderer used, so
    the total shown is the total printed. Not read from a stored total:
    there is no stored total, and inventing a column for one would be a
    second source of truth for a figure the lines already determine.
  */
  const totalMinor = lines
    ? lines.reduce((sum, l) => {
        const unit = Number(l['unitTtcMinor'] ?? 0);
        const qty = Number(l['quantity'] ?? 0);
        return sum + (Number.isFinite(unit) && Number.isFinite(qty) ? unit * qty : 0);
      }, 0)
    : null;
  const seller = p['seller'] as { legalName?: string } | undefined;
  return {
    totalMinor,
    currency: typeof p['currency'] === 'string' ? (p['currency'] as string) : null,
    issuedOn: doc.issuedAt.slice(0, 10),
    issuer: typeof seller?.legalName === 'string' ? seller.legalName : null,
    lineCount: lines ? lines.length : null,
    fields: printedFields(p),
  };
}

/**
 * The payload's own label/value lines, exactly as the renderer prints
 * them.
 *
 * Scalars only, and the keys the invoice summary already covers are
 * dropped so nothing is stated twice. Capped and truncated because this
 * is a comparison aid on a phone screen, not a copy of the document —
 * the document itself is one upload away.
 */
function printedFields(payload: Record<string, unknown>): Array<{ label: string; value: string }> {
  const COVERED = ['lines', 'seller', 'buyer', 'currency', 'buyerNif'];
  const out: Array<{ label: string; value: string }> = [];
  for (const [label, value] of Object.entries(payload ?? {})) {
    if (out.length >= 8) break;
    if (COVERED.indexOf(label) !== -1) continue;
    if (value === null || value === undefined || typeof value === 'object') continue;
    out.push({ label, value: String(value).slice(0, 80) });
  }
  return out;
}

/** One verdict, decided here so no client has to derive it. */
export function decide(r: VerificationResult): VerificationVerdict {
  if (!r.found) return 'not_found';
  if (!r.authentic) return 'compromised';
  if (r.matchesSuppliedFile === true) return r.status === 'void' ? 'void' : 'file_matches';
  if (r.matchesSuppliedFile === false) return 'file_altered';
  if (r.status === 'void') return 'void';
  return 'exists_unchecked';
}

/**
 * The sentence a human holding a printout actually needs.
 *
 * IT MUST NOT SAY THE HOLDER'S DOCUMENT IS UNALTERED when nothing was
 * supplied to compare. It used to: a lookup with no file returned
 * "Authentic and valid: issued by JustGo and unaltered", and a forger
 * who copies a valid fingerprint onto a page showing a different amount
 * gets that sentence read back to them as confirmation. All the server
 * knows at that point is that a document with that fingerprint exists —
 * so that is all it is allowed to say, together with what the real one
 * says and how to finish the check.
 */
export function describe(r: VerificationResult): string {
  switch (r.verdict) {
    case 'not_found':
      return 'No document with that reference was ever issued by JustGo.';
    case 'compromised':
      return 'WARNING: our own sealed copy of this document fails its signature. Do not rely on it; report it.';
    case 'file_altered':
      return 'A genuine document exists under this reference, but the file you supplied is NOT it. Your copy has been altered.';
    case 'void': {
      const on = (r.voidedAt ?? '').slice(0, 10);
      return `This document was genuinely issued by JustGo but was annulled on ${on}. It is no longer valid.`;
    }
    case 'file_matches':
      return 'Authentic and valid: this is exactly the file JustGo issued and sealed.';
    case 'exists_unchecked':
    default: {
      const c = r.content;
      const base =
        `JustGo did issue a document with this fingerprint${r.number ? ` (${r.number})` : ''}` +
        ` and our sealed copy is intact.`;
      /*
        A total is the comparison for a facture. A confirmation has no
        total, and saying only "it is dated the 10th" gives the holder
        nothing to check — so for those we read back what the document
        actually says: the service, the appointment, the car.
      */
      const says =
        c && c.totalMinor === null && c.fields.length > 0
          ? `, and says: ${c.fields
              .slice(0, 4)
              .map((f) => `${f.label} ${f.value}`)
              .join('; ')}`
          : '';
      const compare = c
        ? ` It is dated ${c.issuedOn}${c.issuer ? `, issued by ${c.issuer}` : ''}` +
          (c.totalMinor !== null && c.currency
            ? `, for a total of ${(c.totalMinor / 100).toFixed(2)} ${c.currency}`
            : '') +
          (c.lineCount !== null ? ` across ${c.lineCount} line(s)` : '') +
          says +
          '. CHECK THOSE AGAINST YOUR COPY: if they differ, the paper you are holding is not this document.'
        : '';
      return (
        `${base}${compare} This does NOT confirm the copy you hold — anyone can print a` +
        ' fingerprint onto any page. Upload your PDF for a byte-for-byte check.'
      );
    }
  }
}

export { Ed25519DocumentSigner };
