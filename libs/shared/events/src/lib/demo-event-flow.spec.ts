/**
 * Phase 0 DoD: a demo event flows outbox → relay → bus → consumer.
 */
import { makeEvent, type DomainEvent } from './domain-event';
import { InMemoryEventBus, InMemoryOutboxStore } from './in-memory';
import { OutboxRelay } from './outbox-relay';

describe('demo event flow (outbox → relay → bus → consumer)', () => {
  it('delivers an appended event to a subscribed consumer and marks it published', async () => {
    const outbox = new InMemoryOutboxStore('demo');
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay([outbox], bus);

    const received: DomainEvent[] = [];
    await bus.subscribe('demo.SomethingHappened', async (e) => {
      received.push(e);
    });

    const event = makeEvent({
      type: 'demo.SomethingHappened',
      payload: { hello: 'world' },
    });
    await outbox.append([event]);
    expect(outbox.unpublishedCount()).toBe(1);

    const relayed = await relay.tick();

    expect(relayed).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(event.id);
    expect(received[0].payload).toEqual({ hello: 'world' });
    expect(outbox.unpublishedCount()).toBe(0);

    // second tick relays nothing — already published
    expect(await relay.tick()).toBe(0);
    expect(received).toHaveLength(1);
  });

  it('keeps events unpublished if the bus fails, and retries next tick', async () => {
    const outbox = new InMemoryOutboxStore('demo');
    let failOnce = true;
    const bus = new InMemoryEventBus();
    const flaky = {
      publish: async (events: DomainEvent[]) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('bus down');
        }
        await bus.publish(events);
      },
      subscribe: bus.subscribe.bind(bus),
      close: bus.close.bind(bus),
    };
    const errors: string[] = [];
    const relay = new OutboxRelay([outbox], flaky, {
      onError: (e, schema) => errors.push(`${schema}:${(e as Error).message}`),
    });

    const received: DomainEvent[] = [];
    await bus.subscribe('*', async (e) => {
      received.push(e);
    });

    await outbox.append([makeEvent({ type: 'demo.Flaky', payload: {} })]);

    expect(await relay.tick()).toBe(0); // publish failed
    expect(errors).toEqual(['demo:bus down']);
    expect(outbox.unpublishedCount()).toBe(1);

    expect(await relay.tick()).toBe(1); // retried and delivered
    expect(received).toHaveLength(1);
    expect(outbox.unpublishedCount()).toBe(0);
  });

  it('fans out one event to multiple consumers', async () => {
    const outbox = new InMemoryOutboxStore('demo');
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay([outbox], bus);

    const seenBy: string[] = [];
    await bus.subscribe('demo.FanOut', async () => {
      seenBy.push('notifications');
    });
    await bus.subscribe('demo.FanOut', async () => {
      seenBy.push('analytics');
    });
    await bus.subscribe('*', async () => {
      seenBy.push('audit');
    });

    await outbox.append([makeEvent({ type: 'demo.FanOut', payload: {} })]);
    await relay.tick();

    expect(seenBy.sort()).toEqual(['analytics', 'audit', 'notifications']);
  });
});
