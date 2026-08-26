import { Pool } from 'pg';
import { asId, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import type { NotificationDTO, Recipient } from '../contract/dto';

interface NotificationRow {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  ref_id: string | null;
  read: boolean;
  created_at: Date;
}

export interface DeviceRow {
  fcm_token: string;
  platform: string | null;
}

const COLS = `id, type, title, body, ref_id, read, created_at`;

function toDTO(row: NotificationRow): NotificationDTO {
  return {
    id: asId<Uuid>(row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    refId: row.ref_id ? asId<Uuid>(row.ref_id) : null,
    read: row.read,
    createdAt: row.created_at.toISOString(),
  };
}

/** All SQL confined to the `notifications` schema (§17.4). */
export class PgNotificationsRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    recipient: Recipient,
    n: { type: string; title?: string; body?: string; refId?: string },
  ): Promise<NotificationDTO> {
    const accountId = 'account' in recipient ? recipient.account : null;
    const supplierId = 'supplier' in recipient ? recipient.supplier : null;
    const res = await this.pool.query<NotificationRow>(
      `insert into notifications.notifications (account_id, supplier_id, type, title, body, ref_id)
       values ($1, $2, $3, $4, $5, $6)
       returning ${COLS}`,
      [accountId, supplierId, n.type, n.title ?? null, n.body ?? null, n.refId ?? null],
    );
    return toDTO(res.rows[0]);
  }

  async listForAccount(accountId: AccountId, limit: number): Promise<NotificationDTO[]> {
    const res = await this.pool.query<NotificationRow>(
      `select ${COLS} from notifications.notifications
        where account_id = $1 order by created_at desc limit $2`,
      [accountId, limit],
    );
    return res.rows.map(toDTO);
  }

  async listForSupplier(supplierId: SupplierId, limit: number): Promise<NotificationDTO[]> {
    const res = await this.pool.query<NotificationRow>(
      `select ${COLS} from notifications.notifications
        where supplier_id = $1 order by created_at desc limit $2`,
      [supplierId, limit],
    );
    return res.rows.map(toDTO);
  }

  async unreadForAccount(accountId: AccountId): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `select count(*) n from notifications.notifications where account_id = $1 and not read`,
      [accountId],
    );
    return Number(res.rows[0].n);
  }

  async unreadForSupplier(supplierId: SupplierId): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `select count(*) n from notifications.notifications where supplier_id = $1 and not read`,
      [supplierId],
    );
    return Number(res.rows[0].n);
  }

  /** Scoped update: only the owning recipient can mark a row read. */
  async markRead(recipient: Recipient, id: Uuid): Promise<boolean> {
    const col = 'account' in recipient ? 'account_id' : 'supplier_id';
    const val = 'account' in recipient ? recipient.account : recipient.supplier;
    const res = await this.pool.query(
      `update notifications.notifications set read = true where id = $1 and ${col} = $2`,
      [id, val],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async registerDevice(
    accountId: AccountId,
    supplierId: SupplierId | null,
    input: { fcmToken: string; platform?: string },
  ): Promise<void> {
    await this.pool.query(
      `insert into notifications.devices (account_id, supplier_id, fcm_token, platform)
       values ($1, $2, $3, $4)
       on conflict (account_id, fcm_token)
       do update set supplier_id = excluded.supplier_id, platform = excluded.platform`,
      [accountId, supplierId, input.fcmToken, input.platform ?? null],
    );
  }

  async devicesFor(recipient: Recipient): Promise<DeviceRow[]> {
    const col = 'account' in recipient ? 'account_id' : 'supplier_id';
    const val = 'account' in recipient ? recipient.account : recipient.supplier;
    const res = await this.pool.query<DeviceRow>(
      `select fcm_token, platform from notifications.devices where ${col} = $1`,
      [val],
    );
    return res.rows;
  }
}
