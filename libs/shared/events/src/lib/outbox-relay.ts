import type { EventBus } from './event-bus';
import type { OutboxStore } from './outbox';

export interface OutboxRelayOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown, schema: string) => void;
}

/**
 * Polls module outboxes and publishes unpublished events to the bus (§12).
 * At-least-once: a crash between publish and markPublished re-delivers, and
 * jobId-dedupe plus idempotent consumers absorb it.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly onError: (error: unknown, schema: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly stores: OutboxStore[],
    private readonly bus: EventBus,
    opts: OutboxRelayOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 100;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.onError = opts.onError ?? (() => undefined);
  }

  /** One pass over every store. Returns how many events were relayed. */
  async tick(): Promise<number> {
    let relayed = 0;
    for (const store of this.stores) {
      try {
        const events = await store.fetchUnpublished(this.batchSize);
        if (events.length === 0) continue;
        await this.bus.publish(events);
        await store.markPublished(events.map((e) => e.id));
        relayed += events.length;
      } catch (error) {
        this.onError(error, store.schema);
      }
    }
    return relayed;
  }

  start(): void {
    if (this.timer) return;
    const loop = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.tick();
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void loop(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
