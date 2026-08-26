/**
 * Notifications against the live self-hosted Postgres (§13). Skipped without
 * DATABASE_URL. Proves: the feed persists and scopes by recipient, badge
 * counts, read-state, device registry, and the event → notification reactor
 * path that delivers "supplier sees the request" / "client sees the quote".
 */
import { Pool } from 'pg';
import { newId, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { InMemoryEventBus, makeEvent, type DomainEvent } from '@justgo/events';
import type { RealtimePort } from '@justgo/realtime';
import { PgNotificationsRepository } from './pg-notifications.repository';
import { NotificationsService } from '../application/notifications.service';
import { RealtimeChannel, PushChannel } from '../application/channels';
import { FcmPushSender } from '../application/push-sender';
import { NotificationReactors } from '../application/notification-reactors';
import {
  QUOTE_REQUESTED,
  QUOTE_SUBMITTED,
} from '../application/consumed-events';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

describePg('notifications (integration)', () => {
  let pool: Pool;
  let service: NotificationsService;
  let published: { channel: string; event: string; payload: Record<string, unknown> }[];

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const repo = new PgNotificationsRepository(pool);
    published = [];
    const realtime: RealtimePort = {
      publish: async (channel, event, payload) => {
        published.push({ channel, event, payload });
      },
    };
    service = new NotificationsService(repo, [
      new RealtimeChannel(realtime),
      new PushChannel(new FcmPushSender()),
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('persists an account notification, counts it unread, and marks it read', async () => {
    const accountId = newId<AccountId>();
    const dto = await service.notify({
      recipient: { account: accountId },
      type: 'welcome',
      title: 'Welcome',
    });
    expect(await service.unreadForAccount(accountId)).toBe(1);
    const list = await service.listForAccount(accountId);
    expect(list.map((n) => n.id)).toContain(dto.id);

    await service.markRead({ account: accountId }, dto.id);
    expect(await service.unreadForAccount(accountId)).toBe(0);
  });

  it('does not let one recipient mark another’s notification read', async () => {
    const owner = newId<AccountId>();
    const stranger = newId<AccountId>();
    const dto = await service.notify({ recipient: { account: owner }, type: 'welcome' });
    await service.markRead({ account: stranger }, dto.id); // scoped: no-op
    expect(await service.unreadForAccount(owner)).toBe(1);
  });

  it('keeps account and supplier feeds separate (per-supplier badge)', async () => {
    const supplierId = newId<SupplierId>();
    await service.notify({ recipient: { supplier: supplierId }, type: 'request.received' });
    expect(await service.unreadForSupplier(supplierId)).toBe(1);
    expect((await service.listForSupplier(supplierId)).length).toBe(1);
  });

  it('registers a device and pushes to it (upsert on token)', async () => {
    const accountId = newId<AccountId>();
    const supplierId = newId<SupplierId>();
    await service.registerDevice(accountId, supplierId, { fcmToken: 'tok-x', platform: 'ios' });
    await service.registerDevice(accountId, supplierId, { fcmToken: 'tok-x', platform: 'android' });
    const res = await pool.query(
      `select platform, supplier_id from notifications.devices where account_id = $1`,
      [accountId],
    );
    expect(res.rows).toHaveLength(1); // upserted, not duplicated
    expect(res.rows[0].platform).toBe('android');
    expect(res.rows[0].supplier_id).toBe(supplierId);
  });

  it('reactor: QuoteRequested notifies the supplier on its channel', async () => {
    const bus = new InMemoryEventBus();
    const reactors = new NotificationReactors(bus, service);
    await reactors.onApplicationBootstrap();

    const supplierId = newId<SupplierId>();
    const requestId = newId<Uuid>();
    published.length = 0;
    await bus.publish([
      makeEvent({
        type: QUOTE_REQUESTED,
        payload: {
          quoteId: newId<Uuid>(),
          requestId,
          supplierId,
          clientAccountId: newId<AccountId>(),
          categoryKey: 'braking',
          tecdocArticleId: null,
          freeText: 'Front pads',
        },
      }) as DomainEvent,
    ]);

    expect(await service.unreadForSupplier(supplierId)).toBe(1);
    expect(published.some((p) => p.channel === `supplier:${supplierId}`)).toBe(true);
  });

  it('reactor: QuoteSubmitted notifies the client on its request channel', async () => {
    const bus = new InMemoryEventBus();
    const reactors = new NotificationReactors(bus, service);
    await reactors.onApplicationBootstrap();

    const clientAccountId = newId<AccountId>();
    const requestId = newId<Uuid>();
    published.length = 0;
    await bus.publish([
      makeEvent({
        type: QUOTE_SUBMITTED,
        payload: {
          quoteId: newId<Uuid>(),
          requestId,
          supplierId: newId<SupplierId>(),
          clientAccountId,
          amountMinor: 9500,
          currency: 'EUR',
        },
      }) as DomainEvent,
    ]);

    expect(await service.unreadForAccount(clientAccountId)).toBe(1);
    expect(published.some((p) => p.channel === `request:${requestId}`)).toBe(true);
    expect(published.some((p) => p.channel === `account:${clientAccountId}`)).toBe(true);
  });
});
