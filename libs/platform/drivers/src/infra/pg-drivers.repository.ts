import { Pool, type PoolClient } from 'pg';
import {
  asId,
  NotFoundError,
  type AccountId,
  type SupplierId,
  type Uuid,
} from '@justgo/kernel';
import { makeEvent, PgOutboxStore } from '@justgo/events';
import { DRIVER_REFUSED, DRIVER_SUBMITTED, DRIVER_VERIFIED } from '../contract/events';
import { assertDriverTransition, missingDocuments } from '../domain/driver-state';
import type {
  ApplyAsDriverDTO,
  AttachDocumentDTO,
  DriverAvailabilityDTO,
  DriverDTO,
  DriverDocumentDTO,
  DriverDocumentKind,
  DriverStatus,
  SetAvailabilityDTO,
  UpdateDriverDTO,
} from '../contract/dto';

interface DriverRow {
  id: string;
  account_id: string;
  supplier_id: string | null;
  full_name: string;
  phone: string | null;
  licence_number: string | null;
  licence_expires_on: Date | string | null;
  status: DriverStatus;
  decision_reason: string | null;
  decided_at: Date | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DocumentRow {
  id: string;
  driver_id: string;
  kind: DriverDocumentKind;
  bucket: string;
  path: string;
  uploaded_at: Date;
}

interface AvailabilityRow {
  driver_id: string;
  is_online: boolean;
  lat: number | null;
  lng: number | null;
  last_seen_at: Date;
}

const DRIVER_COLS = `id, account_id, supplier_id, full_name, phone, licence_number,
  licence_expires_on, status, decision_reason, decided_at, verified_at,
  created_at, updated_at`;

function toDocument(r: DocumentRow): DriverDocumentDTO {
  return {
    id: asId<Uuid>(r.id),
    kind: r.kind,
    bucket: r.bucket,
    path: r.path,
    uploadedAt: r.uploaded_at.toISOString(),
  };
}

function toAvailability(r: AvailabilityRow): DriverAvailabilityDTO {
  return {
    isOnline: r.is_online,
    lat: r.lat,
    lng: r.lng,
    lastSeenAt: r.last_seen_at.toISOString(),
  };
}

/** `licence_expires_on` is a DATE; keep it a date string, never an instant. */
function toDateString(value: Date | string | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function toDriver(
  r: DriverRow,
  documents: DriverDocumentDTO[],
  availability: DriverAvailabilityDTO | null,
): DriverDTO {
  return {
    id: asId<Uuid>(r.id),
    accountId: asId<AccountId>(r.account_id),
    supplierId: r.supplier_id ? asId<SupplierId>(r.supplier_id) : null,
    fullName: r.full_name,
    phone: r.phone,
    licenceNumber: r.licence_number,
    licenceExpiresOn: toDateString(r.licence_expires_on),
    status: r.status,
    decisionReason: r.decision_reason,
    decidedAt: r.decided_at?.toISOString() ?? null,
    verifiedAt: r.verified_at?.toISOString() ?? null,
    documents,
    availability,
    missingDocuments: missingDocuments(documents.map((d) => d.kind)),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** All SQL confined to the `drivers` schema (§17.4). */
export class PgDriversRepository {
  private readonly outbox: PgOutboxStore;

  constructor(private readonly pool: Pool) {
    this.outbox = new PgOutboxStore(pool, 'drivers');
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

  private async hydrate(
    client: PoolClient | Pool,
    rows: DriverRow[],
  ): Promise<DriverDTO[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    // Two queries for the whole set, not two per driver.
    const [docs, avail] = await Promise.all([
      client.query<DocumentRow>(
        `select id, driver_id, kind, bucket, path, uploaded_at
           from drivers.verification_documents
          where driver_id = any($1::uuid[]) order by driver_id, kind`,
        [ids],
      ),
      client.query<AvailabilityRow>(
        `select driver_id, is_online, lat, lng, last_seen_at
           from drivers.availability where driver_id = any($1::uuid[])`,
        [ids],
      ),
    ]);

    const byDriver = new Map<string, DriverDocumentDTO[]>();
    for (const row of docs.rows) {
      const list = byDriver.get(row.driver_id);
      if (list) list.push(toDocument(row));
      else byDriver.set(row.driver_id, [toDocument(row)]);
    }
    const availByDriver = new Map<string, DriverAvailabilityDTO>();
    for (const row of avail.rows) availByDriver.set(row.driver_id, toAvailability(row));

    return rows.map((r) =>
      toDriver(r, byDriver.get(r.id) ?? [], availByDriver.get(r.id) ?? null),
    );
  }

  private async oneByAccount(
    client: PoolClient | Pool,
    accountId: AccountId,
  ): Promise<DriverDTO | null> {
    const res = await client.query<DriverRow>(
      `select ${DRIVER_COLS} from drivers.drivers where account_id = $1`,
      [accountId],
    );
    const [out] = await this.hydrate(client, res.rows);
    return out ?? null;
  }

  private async oneById(client: PoolClient | Pool, id: Uuid): Promise<DriverDTO> {
    const res = await client.query<DriverRow>(
      `select ${DRIVER_COLS} from drivers.drivers where id = $1`,
      [id],
    );
    const [out] = await this.hydrate(client, res.rows);
    if (!out) throw new NotFoundError('Driver', id);
    return out;
  }

  /**
   * Create the profile, or return the one this account already has.
   *
   * Idempotent because the app's verification flow is a wizard a user can
   * re-enter: `on conflict do nothing` on the unique account_id means
   * re-opening it does not fail, and — more importantly — does not reset a
   * profile that is already under review back to draft.
   */
  async apply(accountId: AccountId, input: ApplyAsDriverDTO): Promise<DriverDTO> {
    return this.tx(async (client) => {
      await client.query(
        `insert into drivers.drivers
           (account_id, supplier_id, full_name, phone, licence_number, licence_expires_on)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (account_id) do nothing`,
        [
          accountId,
          input.supplierId ?? null,
          input.fullName.trim(),
          input.phone ?? null,
          input.licenceNumber ?? null,
          input.licenceExpiresOn ?? null,
        ],
      );
      const out = await this.oneByAccount(client, accountId);
      if (!out) throw new NotFoundError('Driver', accountId);
      return out;
    });
  }

  async me(accountId: AccountId): Promise<DriverDTO | null> {
    return this.oneByAccount(this.pool, accountId);
  }

  /** Editable details only. The verification decision is never updated here. */
  async update(accountId: AccountId, input: UpdateDriverDTO): Promise<DriverDTO> {
    const res = await this.pool.query<DriverRow>(
      `update drivers.drivers set
         full_name          = coalesce($2, full_name),
         phone              = coalesce($3, phone),
         licence_number     = coalesce($4, licence_number),
         licence_expires_on = coalesce($5, licence_expires_on),
         updated_at         = now()
       where account_id = $1
       returning ${DRIVER_COLS}`,
      [
        accountId,
        input.fullName?.trim() ?? null,
        input.phone ?? null,
        input.licenceNumber ?? null,
        input.licenceExpiresOn ?? null,
      ],
    );
    const [out] = await this.hydrate(this.pool, res.rows);
    if (!out) throw new NotFoundError('Driver', accountId);
    return out;
  }

  /**
   * Latest wins per kind.
   *
   * A driver whose licence photo came out too dark uploads another, and the
   * reviewer must see the new one — not both with no way to tell which is
   * current. The unique index on (driver_id, kind) plus this upsert keeps
   * "one current document per kind" true by construction.
   */
  async attachDocument(accountId: AccountId, input: AttachDocumentDTO): Promise<DriverDTO> {
    return this.tx(async (client) => {
      const driver = await client.query<{ id: string }>(
        `select id from drivers.drivers where account_id = $1`,
        [accountId],
      );
      if (!driver.rows[0]) throw new NotFoundError('Driver', accountId);

      await client.query(
        `insert into drivers.verification_documents (driver_id, kind, bucket, path)
         values ($1,$2,$3,$4)
         on conflict (driver_id, kind)
         do update set bucket = excluded.bucket,
                       path = excluded.path,
                       uploaded_at = now()`,
        [driver.rows[0].id, input.kind, input.bucket, input.path],
      );
      await client.query(`update drivers.drivers set updated_at = now() where id = $1`, [
        driver.rows[0].id,
      ]);
      return this.oneById(client, asId<Uuid>(driver.rows[0].id));
    });
  }

  /** Submit for review, under a row lock so two taps cannot both transition. */
  async submit(accountId: AccountId): Promise<DriverDTO> {
    return this.tx(async (client) => {
      const current = await client.query<DriverRow>(
        `select ${DRIVER_COLS} from drivers.drivers where account_id = $1 for update`,
        [accountId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundError('Driver', accountId);
      assertDriverTransition(row.status, 'pending_review');

      const updated = await client.query<DriverRow>(
        `update drivers.drivers
            set status = 'pending_review',
                decision_reason = null,
                updated_at = now()
          where id = $1 returning ${DRIVER_COLS}`,
        [row.id],
      );
      await this.outbox.appendWith(client, [
        makeEvent({
          type: DRIVER_SUBMITTED,
          aggregateId: asId<Uuid>(row.id),
          payload: {
            driverId: row.id,
            accountId: row.account_id,
            supplierId: row.supplier_id,
            fullName: row.full_name,
          },
        }),
      ]);
      const [out] = await this.hydrate(client, updated.rows);
      return out;
    });
  }

  async decide(input: {
    driverId: Uuid;
    status: Extract<DriverStatus, 'verified' | 'rejected' | 'suspended'>;
    reason?: string;
    decidedByAccountId: AccountId;
  }): Promise<DriverDTO> {
    return this.tx(async (client) => {
      const current = await client.query<DriverRow>(
        `select ${DRIVER_COLS} from drivers.drivers where id = $1 for update`,
        [input.driverId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundError('Driver', input.driverId);
      assertDriverTransition(row.status, input.status);

      const verified = input.status === 'verified';
      const updated = await client.query<DriverRow>(
        `update drivers.drivers
            set status = $2,
                decision_reason = $3,
                decided_by_account_id = $4,
                decided_at = now(),
                verified_at = case when $5 then now() else verified_at end,
                updated_at = now()
          where id = $1 returning ${DRIVER_COLS}`,
        [
          row.id,
          input.status,
          verified ? null : (input.reason ?? null),
          input.decidedByAccountId,
          verified,
        ],
      );

      /*
        A suspended or rejected driver must not stay online. Clearing it here,
        in the same transaction as the decision, means there is no window in
        which dispatch could still pick them up.
      */
      if (!verified) {
        await client.query(
          `update drivers.availability set is_online = false, updated_at = now()
            where driver_id = $1`,
          [row.id],
        );
      }

      await this.outbox.appendWith(client, [
        verified
          ? makeEvent({
              type: DRIVER_VERIFIED,
              aggregateId: asId<Uuid>(row.id),
              payload: {
                driverId: row.id,
                accountId: row.account_id,
                supplierId: row.supplier_id,
                verifiedAt: new Date().toISOString(),
              },
            })
          : makeEvent({
              type: DRIVER_REFUSED,
              aggregateId: asId<Uuid>(row.id),
              payload: {
                driverId: row.id,
                accountId: row.account_id,
                status: input.status,
                reason: input.reason ?? '',
              },
            }),
      ]);

      const [out] = await this.hydrate(client, updated.rows);
      return out;
    });
  }

  async pendingReview(limit: number): Promise<DriverDTO[]> {
    const res = await this.pool.query<DriverRow>(
      `select ${DRIVER_COLS} from drivers.drivers
        where status = 'pending_review'
        order by updated_at
        limit $1`,
      [limit],
    );
    return this.hydrate(this.pool, res.rows);
  }

  async setAvailability(accountId: AccountId, input: SetAvailabilityDTO): Promise<DriverDTO> {
    return this.tx(async (client) => {
      const driver = await client.query<{ id: string; status: DriverStatus }>(
        `select id, status from drivers.drivers where account_id = $1`,
        [accountId],
      );
      if (!driver.rows[0]) throw new NotFoundError('Driver', accountId);

      await client.query(
        `insert into drivers.availability (driver_id, is_online, lat, lng, last_seen_at, updated_at)
         values ($1,$2,$3,$4, now(), now())
         on conflict (driver_id)
         do update set is_online = excluded.is_online,
                       -- Keep the last known position when a ping omits one,
                       -- rather than blanking it: a driver who went offline is
                       -- still the last place we saw them.
                       lat = coalesce(excluded.lat, drivers.availability.lat),
                       lng = coalesce(excluded.lng, drivers.availability.lng),
                       last_seen_at = now(),
                       updated_at = now()`,
        [driver.rows[0].id, input.isOnline, input.lat ?? null, input.lng ?? null],
      );
      return this.oneById(client, asId<Uuid>(driver.rows[0].id));
    });
  }
}
