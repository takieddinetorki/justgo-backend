import { Pool, type PoolClient } from 'pg';
import { asId, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { DOCUMENT_ISSUED, DOCUMENT_VOIDED } from '../contract/events';
import type { DocumentDTO, DocumentStatus, DocumentType } from '../contract/dto';

interface DocumentRow {
  id: string;
  type: DocumentType;
  number: string;
  subject_type: string;
  subject_id: string;
  issued_to_account_id: string | null;
  supplier_id: string | null;
  bucket: string;
  path: string;
  byte_size: number;
  sha256: string;
  signature: string;
  algo: string;
  key_id: string;
  signature_format: 'detached' | 'embedded';
  status: DocumentStatus;
  issued_at: Date;
  voided_at: Date | null;
  void_reason: string | null;
}

function toDTO(r: DocumentRow): DocumentDTO {
  return {
    id: asId<Uuid>(r.id),
    type: r.type,
    number: r.number,
    subjectType: r.subject_type,
    subjectId: asId<Uuid>(r.subject_id),
    issuedToAccountId: r.issued_to_account_id ? asId<AccountId>(r.issued_to_account_id) : null,
    supplierId: r.supplier_id ? asId<SupplierId>(r.supplier_id) : null,
    status: r.status,
    sha256: r.sha256,
    algo: r.algo,
    keyId: r.key_id,
    signatureFormat: r.signature_format,
    byteSize: r.byte_size,
    issuedAt: r.issued_at.toISOString(),
    voidedAt: r.voided_at ? r.voided_at.toISOString() : null,
    voidReason: r.void_reason,
  };
}

const COLUMNS = `id, type, number, subject_type, subject_id, issued_to_account_id,
  supplier_id, bucket, path, byte_size, sha256, signature, algo, key_id,
  signature_format, status, issued_at, voided_at, void_reason`;

/** All SQL confined to the `documents` schema (§17.4). */
export class PgDocumentsRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'documents');
  }

  /**
   * Reserves the next number AND the previous document's hash, inside the
   * caller's transaction.
   *
   * `for update` on the counter row serialises concurrent issuance of the
   * same series: two requests cannot both read `next_seq = 14`. A Postgres
   * sequence would be simpler and wrong — sequences deliberately leak
   * numbers on rollback, and a fiscal series may not have gaps.
   *
   * The chain head is read under the same lock, so `prev_sha256` always
   * refers to the document immediately before this one.
   */
  private async reserveNumber(
    client: PoolClient,
    series: string,
    year: number,
  ): Promise<{ seq: number; number: string; prevSha256: string | null }> {
    await client.query(
      `insert into documents.number_counters (series, year) values ($1, $2)
       on conflict do nothing`,
      [series, year],
    );
    const counter = await client.query<{ next_seq: number }>(
      `select next_seq from documents.number_counters
        where series = $1 and year = $2 for update`,
      [series, year],
    );
    const seq = counter.rows[0]?.next_seq ?? 1;
    await client.query(
      `update documents.number_counters set next_seq = $3
        where series = $1 and year = $2`,
      [series, year, seq + 1],
    );

    const head = await client.query<{ sha256: string }>(
      `select sha256 from documents.documents
        where series = $1 and year = $2
        order by seq desc limit 1`,
      [series, year],
    );

    return {
      seq,
      number: `${series}-${year}-${String(seq).padStart(6, '0')}`,
      prevSha256: head.rows[0]?.sha256 ?? null,
    };
  }

  /**
   * Runs `render` INSIDE the numbering transaction.
   *
   * The document has to carry its own number and chain hash, so it cannot
   * be rendered before the number is reserved — and the number must not
   * be consumed if rendering or storage then fails. One transaction keeps
   * the series gapless even when issuance breaks halfway.
   */
  async issue(input: {
    type: DocumentType;
    series: string;
    year: number;
    subjectType: string;
    subjectId: string;
    issuedToAccountId?: string;
    issuedByAccountId?: string;
    supplierId?: string;
    payload: Record<string, unknown>;
    render: (ctx: { number: string; prevSha256: string | null; issuedAt: Date }) => Promise<{
      bucket: string;
      path: string;
      bytes: Uint8Array;
      sha256: string;
      signature: string;
      algo: string;
      keyId: string;
      format: 'detached' | 'embedded';
    }>;
  }): Promise<DocumentDTO> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { seq, number, prevSha256 } = await this.reserveNumber(
        client,
        input.series,
        input.year,
      );
      const issuedAt = new Date();
      const sealed = await input.render({ number, prevSha256, issuedAt });

      const res = await client.query<DocumentRow>(
        `insert into documents.documents
           (type, series, year, seq, number, subject_type, subject_id,
            issued_to_account_id, issued_by_account_id, supplier_id,
            bucket, path, byte_size, sha256, signature, algo, key_id,
            signature_format, prev_sha256, payload_snapshot, issued_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         returning ${COLUMNS}`,
        [
          input.type, input.series, input.year, seq, number,
          input.subjectType, input.subjectId,
          input.issuedToAccountId ?? null, input.issuedByAccountId ?? null,
          input.supplierId ?? null,
          sealed.bucket, sealed.path, sealed.bytes.byteLength, sealed.sha256,
          sealed.signature, sealed.algo, sealed.keyId, sealed.format,
          prevSha256, JSON.stringify(input.payload), issuedAt,
        ],
      );
      const row = res.rows[0];
      if (!row) throw new Error('document insert returned no row');

      await this.outbox.appendWith(client, [
        makeEvent({
          type: DOCUMENT_ISSUED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            documentId: row.id,
            type: row.type,
            number: row.number,
            subjectType: row.subject_type,
            subjectId: row.subject_id,
            issuedToAccountId: row.issued_to_account_id,
            sha256: row.sha256,
            issuedAt: row.issued_at.toISOString(),
          },
        }),
      ]);
      await client.query('commit');
      return toDTO(row);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async byNumber(
    number: string,
  ): Promise<(DocumentDTO & { bucket: string; path: string; signature: string }) | null> {
    const res = await this.pool.query<DocumentRow>(
      `select ${COLUMNS} from documents.documents where number = $1`,
      [number],
    );
    const row = res.rows[0];
    return row
      ? { ...toDTO(row), bucket: row.bucket, path: row.path, signature: row.signature }
      : null;
  }

  async byId(
    id: Uuid,
  ): Promise<(DocumentDTO & { bucket: string; path: string; signature: string }) | null> {
    const res = await this.pool.query<DocumentRow>(
      `select ${COLUMNS} from documents.documents where id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row
      ? { ...toDTO(row), bucket: row.bucket, path: row.path, signature: row.signature }
      : null;
  }

  async listForAccount(accountId: AccountId, limit: number): Promise<DocumentDTO[]> {
    const res = await this.pool.query<DocumentRow>(
      `select ${COLUMNS} from documents.documents
        where issued_to_account_id = $1
        order by issued_at desc limit $2`,
      [accountId, limit],
    );
    return res.rows.map(toDTO);
  }

  /**
   * Marks a document void. The stored object is NOT touched — voiding is
   * a new fact about a document, never an edit to one.
   */
  async void(input: {
    documentId: Uuid;
    voidedBy: AccountId;
    reason: string;
  }): Promise<DocumentDTO | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query<DocumentRow>(
        `update documents.documents
            set status = 'void', voided_at = now(), voided_by = $2, void_reason = $3
          where id = $1 and status = 'issued'
          returning ${COLUMNS}`,
        [input.documentId, input.voidedBy, input.reason],
      );
      const row = res.rows[0];
      if (!row) {
        await client.query('rollback');
        return null;
      }
      await this.outbox.appendWith(client, [
        makeEvent({
          type: DOCUMENT_VOIDED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            documentId: row.id,
            number: row.number,
            voidedBy: input.voidedBy,
            reason: input.reason,
            voidedAt: (row.voided_at ?? new Date()).toISOString(),
          },
        }),
      ]);
      await client.query('commit');
      return toDTO(row);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
