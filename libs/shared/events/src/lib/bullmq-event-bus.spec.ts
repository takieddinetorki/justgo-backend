import { BullMqEventBus } from './bullmq-event-bus';
import { makeEvent, type DomainEvent } from './domain-event';
import type { EventHandler } from './event-bus';

/**
 * Dispatch semantics, without Redis.
 *
 * `handlersFor` is private, so these reach it the way the Worker does.
 * The property under test is which handlers a given event type resolves
 * to — the piece that was silently broken in the bundled apps, where
 * `[...setA, ...setB]` downlevelled to `[].concat(setA, setB)` and
 * produced Sets where functions were expected.
 */
type BusInternals = {
  handlersFor(type: string): EventHandler[];
};

const internals = (bus: BullMqEventBus) => bus as unknown as BusInternals;

describe('BullMqEventBus dispatch', () => {
  let bus: BullMqEventBus;

  beforeEach(() => {
    bus = new BullMqEventBus({ redisUrl: 'redis://localhost:6379' });
  });

  /*
    `subscribe` calls `ensureWorker`, which opens a real Redis connection.
    Without this the handles outlive the run and jest force-exits the
    worker — which fails the task even though every assertion passed.
  */
  afterEach(async () => {
    await bus.close();
  });

  const noop: EventHandler = async () => undefined;

  it('resolves handlers to callables, never to the Set holding them', async () => {
    await bus.subscribe('a.Happened', noop);

    const targets = internals(bus).handlersFor('a.Happened');

    expect(targets).toHaveLength(1);
    // The regression: `[].concat(set)` yields [Set], which is truthy,
    // iterable and NOT callable — so this is the assertion that matters.
    expect(typeof targets[0]).toBe('function');
  });

  it('delivers to every handler registered for the type', async () => {
    const seen: string[] = [];
    await bus.subscribe('a.Happened', async () => void seen.push('first'));
    await bus.subscribe('a.Happened', async () => void seen.push('second'));

    for (const h of internals(bus).handlersFor('a.Happened')) {
      await h({} as DomainEvent);
    }
    expect(seen).toEqual(['first', 'second']);
  });

  it('adds wildcard subscribers to every type', async () => {
    await bus.subscribe('a.Happened', noop);
    await bus.subscribe('*', noop);

    expect(internals(bus).handlersFor('a.Happened')).toHaveLength(2);
    expect(internals(bus).handlersFor('b.Happened')).toHaveLength(1);
  });

  it('does not deliver a wildcard event twice to its own subscriber', async () => {
    await bus.subscribe('*', noop);
    // A '*' event type would otherwise match both the exact lookup and
    // the wildcard one.
    expect(internals(bus).handlersFor('*')).toHaveLength(1);
  });

  it('drops a handler on unsubscribe', async () => {
    const sub = await bus.subscribe('a.Happened', noop);
    await sub.unsubscribe();
    expect(internals(bus).handlersFor('a.Happened')).toHaveLength(0);
  });

  it('resolves nothing for a type nobody subscribed to', () => {
    expect(internals(bus).handlersFor('c.Happened')).toEqual([]);
  });

  it('keeps makeEvent’s type as the dispatch key', async () => {
    const event = makeEvent({ type: 'a.Happened', payload: {} });
    await bus.subscribe(event.type, noop);
    expect(internals(bus).handlersFor(event.type)).toHaveLength(1);
  });
});
