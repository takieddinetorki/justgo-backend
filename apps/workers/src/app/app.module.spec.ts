import { Test } from '@nestjs/testing';
import { EVENT_BUS, InMemoryOutboxStore, makeEvent, OUTBOX_STORE } from '@justgo/events';
import type { EventBus, OutboxStore } from '@justgo/events';
import { AppModule } from './app.module';
import { OutboxRelayRunner } from './outbox-relay.runner';

describe('workers AppModule', () => {
  it('wires the relay against in-memory infra and relays an appended event', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const stores = app.get<OutboxStore[]>(OUTBOX_STORE);
    const bus = app.get<EventBus>(EVENT_BUS);
    expect(app.get(OutboxRelayRunner)).toBeDefined();
    expect(stores.length).toBeGreaterThan(0);

    const received: string[] = [];
    await bus.subscribe('demo.WiredUp', async (e) => {
      received.push(e.type);
    });
    const demo = stores[0] as InMemoryOutboxStore;
    await demo.append([makeEvent({ type: 'demo.WiredUp', payload: {} })]);

    // relay polls every 500ms by default; wait for delivery
    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received).toEqual(['demo.WiredUp']);

    await app.close();
  });
});
