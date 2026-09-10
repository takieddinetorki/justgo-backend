import { Queue, Worker } from 'bullmq';
import type { DomainEvent } from './domain-event';
import type { EventBus, EventHandler, Subscription } from './event-bus';

export interface BullMqEventBusOptions {
  redisUrl: string;
  /** One stream for all domain events in the monolith (§12). */
  queueName?: string;
}

/**
 * BullMQ-backed bus. Publishing enqueues with jobId = event id, so redelivery
 * of the same event is deduped by the queue; consumers must still be
 * idempotent (at-least-once).
 */
export class BullMqEventBus implements EventBus {
  private readonly queueName: string;
  private readonly redisUrl: string;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(opts: BullMqEventBusOptions) {
    this.redisUrl = opts.redisUrl;
    this.queueName = opts.queueName ?? 'domain-events';
  }

  private getQueue(): Queue {
    this.queue ??= new Queue(this.queueName, {
      connection: { url: this.redisUrl },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 24 * 3600, count: 10_000 },
        removeOnFail: false,
      },
    });
    return this.queue;
  }

  async publish(events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.getQueue().addBulk(
      events.map((event) => ({
        name: event.type,
        data: event,
        opts: { jobId: event.id },
      })),
    );
  }

  async subscribe(type: string, handler: EventHandler): Promise<Subscription> {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    this.ensureWorker();
    return {
      unsubscribe: async () => {
        set.delete(handler);
      },
    };
  }

  /**
   * Collected with `Set.forEach`, NOT `[...setA, ...setB]`.
   *
   * This is not style. The apps are webpack+SWC bundles, and SWC's loose
   * downlevel rewrites that spread as `[].concat(setA, setB)` — and
   * `Array.prototype.concat` does not spread a Set, it appends it. Every
   * job then failed with "handler is not a function", so NO cross-process
   * domain event was ever delivered in a built app: no fan-out, no
   * order-from-quote, no notifications, no discovery indexing.
   *
   * It survived because every integration test drives `InMemoryEventBus`
   * in-process under ts-jest, where the spread compiles correctly. The
   * bundle was the only place it broke, and nothing tested the bundle.
   */
  private handlersFor(type: string): EventHandler[] {
    const targets: EventHandler[] = [];
    this.handlers.get(type)?.forEach((h) => targets.push(h));
    if (type !== '*') this.handlers.get('*')?.forEach((h) => targets.push(h));
    return targets;
  }

  private ensureWorker(): void {
    this.worker ??= new Worker(
      this.queueName,
      async (job) => {
        const event = job.data as DomainEvent;
        for (const handler of this.handlersFor(event.type)) {
          if (typeof handler !== 'function') {
            // Belt and braces for the class of bug described above: fail
            // with something that names the cause, not `handler is not a
            // function` eight frames deep in BullMQ.
            throw new TypeError(
              `Event handler for "${event.type}" is not callable (got ${typeof handler})`,
            );
          }
          await handler(event);
        }
      },
      { connection: { url: this.redisUrl } },
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.worker = null;
    this.queue = null;
    this.handlers.clear();
  }
}
