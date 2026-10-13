import { Pool, type PoolClient } from 'pg';
import {
  asId,
  NotFoundError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { CASE_FILED, CASE_MESSAGE_POSTED, CASE_STATUS_CHANGED } from '../contract/events';
import { assertCaseTransition } from '../domain/case-state';
import type {
  CaseAttachmentDTO,
  CaseAuthorRole,
  CaseCategory,
  CaseDTO,
  CaseMessageDTO,
  CasePage,
  CaseQuery,
  CaseStatus,
  CaseSubjectType,
  FileCaseDTO,
} from '../contract/dto';

interface CaseRow {
  id: string;
  reference: string;
  claimant_account_id: string;
  respondent_supplier_id: string | null;
  subject_type: CaseSubjectType | null;
  subject_id: string | null;
  category: CaseCategory;
  title: string;
  body: string;
  status: CaseStatus;
  resolution: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  message_count: string;
}

interface AttachmentRow {
  id: string;
  case_id: string;
  uploaded_by_account_id: string;
  bucket: string;
  path: string;
  created_at: Date;
}

interface MessageRow {
  id: string;
  case_id: string;
  author_account_id: string;
  author_role: CaseAuthorRole;
  body: string;
  internal: boolean;
  created_at: Date;
}

const CASE_COLS = `c.id, c.reference, c.claimant_account_id, c.respondent_supplier_id,
  c.subject_type, c.subject_id, c.category, c.title, c.body, c.status, c.resolution,
  c.closed_at, c.created_at, c.updated_at`;

const MESSAGE_COLS = `id, case_id, author_account_id, author_role, body, internal, created_at`;

function toAttachment(r: AttachmentRow): CaseAttachmentDTO {
  return {
    id: asId<Uuid>(r.id),
    bucket: r.bucket,
    path: r.path,
    uploadedByAccountId: asId<AccountId>(r.uploaded_by_account_id),
    createdAt: r.created_at.toISOString(),
  };
}

function toMessage(r: MessageRow): CaseMessageDTO {
  return {
    id: asId<Uuid>(r.id),
    caseId: asId<Uuid>(r.case_id),
    authorAccountId: asId<AccountId>(r.author_account_id),
    authorRole: r.author_role,
    body: r.body,
    internal: r.internal,
    createdAt: r.created_at.toISOString(),
  };
}

function toCase(r: CaseRow, attachments: CaseAttachmentDTO[]): CaseDTO {
  return {
    id: asId<Uuid>(r.id),
    reference: r.reference,
    claimantAccountId: asId<AccountId>(r.claimant_account_id),
    respondentSupplierId: r.respondent_supplier_id
      ? asId<SupplierId>(r.respondent_supplier_id)
      : null,
    subjectType: r.subject_type,
    subjectId: r.subject_id ? asId<Uuid>(r.subject_id) : null,
    category: r.category,
    title: r.title,
    body: r.body,
    status: r.status,
    resolution: r.resolution,
    attachments,
    messageCount: Number(r.message_count ?? 0),
    closedAt: r.closed_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}\u0000${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000');
    return at && id ? { at, id } : null;
  } catch {
    return null;
  }
}

/** All SQL confined to the `reclamations` schema (§17.4). */
export class PgReclamationsRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'reclamations');
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async attachmentsFor(
    client: PoolClient | Pool,
    caseIds: string[],
  ): Promise<Map<string, CaseAttachmentDTO[]>> {
    const byCase = new Map<string, CaseAttachmentDTO[]>();
    if (caseIds.length === 0) return byCase;

    // One query for the whole page — a list of 20 cases must not become 21
    // round trips.
    const res = await client.query<AttachmentRow>(
      `select id, case_id, uploaded_by_account_id, bucket, path, created_at
         from reclamations.case_attachments
        where case_id = any($1::uuid[])
        order by case_id, created_at`,
      [caseIds],
    );
    for (const row of res.rows) {
      const list = byCase.get(row.case_id);
      if (list) list.push(toAttachment(row));
      else byCase.set(row.case_id, [toAttachment(row)]);
    }
    return byCase;
  }

  async file(claimant: AccountId, input: FileCaseDTO): Promise<CaseDTO> {
    return this.tx(async (client) => {
      /*
        The reference is built from a sequence inside the same transaction, so
        a rolled-back filing does not leave a case numbered but absent. Gaps
        are fine here — unlike an invoice series, nothing requires a complaint
        reference to be gapless, and a sequence avoids serialising every
        filing behind one lock.
      */
      const seq = await client.query<{ n: string }>(
        `select nextval('reclamations.case_seq') as n`,
      );
      const year = new Date().getFullYear();
      const reference = `RCL-${year}-${String(seq.rows[0].n).padStart(6, '0')}`;

      const inserted = await client.query<CaseRow>(
        `insert into reclamations.cases
           (reference, claimant_account_id, respondent_supplier_id,
            subject_type, subject_id, category, title, body)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning id, reference, claimant_account_id, respondent_supplier_id,
                   subject_type, subject_id, category, title, body, status,
                   resolution, closed_at, created_at, updated_at`,
        [
          reference,
          claimant,
          input.respondentSupplierId ?? null,
          input.subjectType ?? null,
          input.subjectId ?? null,
          input.category,
          input.title.trim(),
          input.body.trim(),
        ],
      );
      const row = inserted.rows[0];

      for (const a of input.attachments ?? []) {
        await client.query(
          `insert into reclamations.case_attachments
             (case_id, uploaded_by_account_id, bucket, path)
           values ($1,$2,$3,$4)`,
          [row.id, claimant, a.bucket, a.path],
        );
      }

      await this.outbox.appendWith(client, [
        makeEvent({
          type: CASE_FILED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            caseId: row.id,
            reference: row.reference,
            claimantAccountId: row.claimant_account_id,
            respondentSupplierId: row.respondent_supplier_id,
            category: row.category,
            title: row.title,
            subjectType: row.subject_type,
            subjectId: row.subject_id,
          },
        }),
      ]);

      const attachments = await this.attachmentsFor(client, [row.id]);
      return toCase({ ...row, message_count: '0' }, attachments.get(row.id) ?? []);
    });
  }

  /**
   * Cases visible to a party.
   *
   * `ops` passes neither id and sees everything. Otherwise the WHERE clause
   * is the authorisation: a case that is neither yours as claimant nor
   * against your business simply is not in the result, which is also why a
   * single-case read returns 404 rather than 403.
   */
  async list(
    scope: { claimantAccountId?: AccountId; respondentSupplierId?: SupplierId; ops?: boolean },
    query: CaseQuery = {},
  ): Promise<CasePage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (!scope.ops) {
      const party: string[] = [];
      if (scope.claimantAccountId) {
        params.push(scope.claimantAccountId);
        party.push(`c.claimant_account_id = $${params.length}`);
      }
      if (scope.respondentSupplierId) {
        params.push(scope.respondentSupplierId);
        party.push(`c.respondent_supplier_id = $${params.length}`);
      }
      // No party at all must match NOTHING, never everything.
      conditions.push(party.length > 0 ? `(${party.join(' or ')})` : 'false');
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`c.status = $${params.length}`);
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      params.push(cursor.at, cursor.id);
      conditions.push(
        `(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit + 1);

    const res = await this.pool.query<CaseRow>(
      `select ${CASE_COLS},
              (select count(*) from reclamations.case_messages m
                where m.case_id = c.id and m.internal = false) as message_count
         from reclamations.cases c
        ${conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''}
        order by c.created_at desc, c.id desc
        limit $${params.length}`,
      params,
    );

    const rows = res.rows.slice(0, limit);
    const attachments = await this.attachmentsFor(this.pool, rows.map((r) => r.id));
    const last = rows[rows.length - 1];
    return {
      items: rows.map((r) => toCase(r, attachments.get(r.id) ?? [])),
      nextCursor: res.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async get(
    caseId: Uuid,
    scope: { claimantAccountId?: AccountId; respondentSupplierId?: SupplierId; ops?: boolean },
  ): Promise<CaseDTO | null> {
    const params: unknown[] = [caseId];
    let guard = '';
    if (!scope.ops) {
      const party: string[] = [];
      if (scope.claimantAccountId) {
        params.push(scope.claimantAccountId);
        party.push(`c.claimant_account_id = $${params.length}`);
      }
      if (scope.respondentSupplierId) {
        params.push(scope.respondentSupplierId);
        party.push(`c.respondent_supplier_id = $${params.length}`);
      }
      guard = ` and ${party.length > 0 ? `(${party.join(' or ')})` : 'false'}`;
    }

    const res = await this.pool.query<CaseRow>(
      `select ${CASE_COLS},
              (select count(*) from reclamations.case_messages m
                where m.case_id = c.id and m.internal = false) as message_count
         from reclamations.cases c
        where c.id = $1${guard}`,
      params,
    );
    const row = res.rows[0];
    if (!row) return null;
    const attachments = await this.attachmentsFor(this.pool, [row.id]);
    return toCase(row, attachments.get(row.id) ?? []);
  }

  async postMessage(
    caseId: Uuid,
    author: AccountId,
    role: CaseAuthorRole,
    body: string,
    internal: boolean,
    notify: string[],
    notifySupplierId: string | null,
  ): Promise<CaseMessageDTO> {
    return this.tx(async (client) => {
      const parent = await client.query<{ reference: string }>(
        `select reference from reclamations.cases where id = $1`,
        [caseId],
      );
      if (!parent.rows[0]) throw new NotFoundError('Case', caseId);

      const res = await client.query<MessageRow>(
        `insert into reclamations.case_messages
           (case_id, author_account_id, author_role, body, internal)
         values ($1,$2,$3,$4,$5)
         returning ${MESSAGE_COLS}`,
        [caseId, author, role, body.trim(), internal],
      );
      await client.query(`update reclamations.cases set updated_at = now() where id = $1`, [
        caseId,
      ]);
      const message = toMessage(res.rows[0]);

      // An internal note notifies nobody — that is what makes it internal.
      if (!internal) {
        await this.outbox.appendWith(client, [
          makeEvent({
            type: CASE_MESSAGE_POSTED,
            aggregateId: asId<Uuid>(caseId),
            payload: {
              caseId,
              reference: parent.rows[0].reference,
              messageId: message.id,
              authorAccountId: author,
              authorRole: role,
              notifyAccountIds: notify,
              notifySupplierId,
              preview: message.body.slice(0, 140),
            },
          }),
        ]);
      }
      return message;
    });
  }

  async listMessages(caseId: Uuid, includeInternal: boolean): Promise<CaseMessageDTO[]> {
    const res = await this.pool.query<MessageRow>(
      `select ${MESSAGE_COLS} from reclamations.case_messages
        where case_id = $1 ${includeInternal ? '' : 'and internal = false'}
        order by created_at, id`,
      [caseId],
    );
    return res.rows.map(toMessage);
  }

  /**
   * Move the case under a row lock.
   *
   * The lock is what makes the state machine mean anything: without it two
   * concurrent calls both read `open` and both pass `assertCaseTransition`,
   * so a case could be resolved and rejected at once and the second write
   * would quietly overwrite the first resolution.
   */
  async changeStatus(
    caseId: Uuid,
    next: CaseStatus,
    resolution: string | null,
  ): Promise<CaseDTO> {
    return this.tx(async (client) => {
      const current = await client.query<CaseRow>(
        `select ${CASE_COLS} from reclamations.cases c where c.id = $1 for update`,
        [caseId],
      );
      if (!current.rows[0]) throw new NotFoundError('Case', caseId);
      const from = current.rows[0].status;
      assertCaseTransition(from, next);

      const closes = next !== 'open' && next !== 'under_review';
      const res = await client.query<CaseRow>(
        `update reclamations.cases
            set status = $2,
                resolution = $3,
                closed_at = case when $4 then now() else closed_at end,
                updated_at = now()
          where id = $1
          returning id, reference, claimant_account_id, respondent_supplier_id,
                    subject_type, subject_id, category, title, body, status,
                    resolution, closed_at, created_at, updated_at`,
        [caseId, next, resolution, closes],
      );
      const row = res.rows[0];

      await this.outbox.appendWith(client, [
        makeEvent({
          type: CASE_STATUS_CHANGED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            caseId: row.id,
            reference: row.reference,
            claimantAccountId: row.claimant_account_id,
            respondentSupplierId: row.respondent_supplier_id,
            from,
            to: next,
            resolution: row.resolution,
          },
        }),
      ]);

      const attachments = await this.attachmentsFor(client, [row.id]);
      const counted = await client.query<{ n: string }>(
        `select count(*) as n from reclamations.case_messages
          where case_id = $1 and internal = false`,
        [row.id],
      );
      return toCase({ ...row, message_count: counted.rows[0].n }, attachments.get(row.id) ?? []);
    });
  }
}
