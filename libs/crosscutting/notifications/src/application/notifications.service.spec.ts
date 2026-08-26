import { newId, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { NotificationsService } from './notifications.service';
import type { NotificationChannel, DeliverContext } from './channels';
import type { PgNotificationsRepository } from '../infra/pg-notifications.repository';
import type { NotificationDTO, Recipient } from '../contract/dto';

class FakeRepo {
  rows: { recipient: Recipient; dto: NotificationDTO }[] = [];
  async insert(recipient: Recipient, n: { type: string; title?: string; body?: string; refId?: string }) {
    const dto: NotificationDTO = {
      id: newId<Uuid>(),
      type: n.type,
      title: n.title ?? null,
      body: n.body ?? null,
      refId: (n.refId as Uuid) ?? null,
      read: false,
      createdAt: new Date().toISOString(),
    };
    this.rows.push({ recipient, dto });
    return dto;
  }
  async devicesFor() {
    return [{ fcm_token: 'tok-1', platform: 'android' }];
  }
}

class SpyChannel implements NotificationChannel {
  delivered: DeliverContext[] = [];
  constructor(private readonly fail = false) {}
  async deliver(ctx: DeliverContext): Promise<void> {
    if (this.fail) throw new Error('channel boom');
    this.delivered.push(ctx);
  }
}

describe('NotificationsService.notify', () => {
  it('persists first, then delivers on every channel with the persisted row', async () => {
    const repo = new FakeRepo();
    const realtime = new SpyChannel();
    const push = new SpyChannel();
    const svc = new NotificationsService(
      repo as unknown as PgNotificationsRepository,
      [realtime, push],
    );

    const accountId = newId<AccountId>();
    const dto = await svc.notify({
      recipient: { account: accountId },
      type: 'quote.received',
      refId: newId<Uuid>(),
      extraChannels: ['request:r1'],
      data: { amountMinor: 9500 },
    });

    expect(repo.rows).toHaveLength(1);
    expect(realtime.delivered).toHaveLength(1);
    expect(push.delivered).toHaveLength(1);
    expect(realtime.delivered[0].notification.id).toBe(dto.id);
    expect(realtime.delivered[0].extraChannels).toEqual(['request:r1']);
    expect(realtime.delivered[0].devices).toEqual([{ fcm_token: 'tok-1', platform: 'android' }]);
    expect(realtime.delivered[0].event).toBe('quote.received'); // defaults to type
    expect(realtime.delivered[0].data).toEqual({ amountMinor: 9500 });
  });

  it('is best-effort: a failing channel does not fail notify or block others', async () => {
    const repo = new FakeRepo();
    const failing = new SpyChannel(true);
    const ok = new SpyChannel();
    const svc = new NotificationsService(
      repo as unknown as PgNotificationsRepository,
      [failing, ok],
    );
    const supplierId = newId<SupplierId>();
    await expect(
      svc.notify({ recipient: { supplier: supplierId }, type: 'request.received' }),
    ).resolves.toBeDefined();
    expect(repo.rows).toHaveLength(1);
    expect(ok.delivered).toHaveLength(1); // the healthy channel still ran
  });
});
