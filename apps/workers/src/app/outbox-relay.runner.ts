import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  EVENT_BUS,
  OutboxRelay,
  OUTBOX_STORE,
  type EventBus,
  type OutboxStore,
} from '@justgo/events';

/**
 * Runs the outbox relay loop (§12).
 *
 * This process has no HTTP listener, and `OutboxRelay` deliberately
 * `unref()`s its poll timer so tests do not hang on it — which leaves
 * nothing holding the event loop open. It used to survive by accident:
 * a wildcard subscription "for logging" spun up a BullMQ Worker whose
 * Redis socket kept the process alive. That accident also made this a
 * competing consumer against the API (see onApplicationBootstrap), so
 * removing it means keeping the process alive on purpose instead.
 */
@Injectable()
export class OutboxRelayRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayRunner.name);
  private relay: OutboxRelay | null = null;
  /** Ref'd, unlike the relay's own timer: this is what keeps us running. */
  private keepAlive: NodeJS.Timeout | null = null;

  constructor(
    @Inject(OUTBOX_STORE) private readonly stores: OutboxStore[],
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    /*
      NO wildcard subscription here.

      This used to subscribe to '*' just to log "event consumed" — but on
      the BullMQ bus, subscribing is what spins up a consumer. That made
      this process a COMPETING consumer against the API, which is where
      every reactor actually lives. Jobs it won were logged and dropped;
      the fan-out, order-from-quote, notification and supplier-role
      reactors simply never saw them. Whether a domain event took effect
      came down to which process grabbed the job.

      The relay's job is to PUBLISH the outbox. Until the reactors move
      into this process (spec §5), consuming belongs to the API alone.
    */
    this.relay = new OutboxRelay(this.stores, this.bus, {
      pollIntervalMs: Number(process.env['OUTBOX_POLL_MS'] ?? 500),
      onError: (error, schema) =>
        this.logger.error(`relay failed for schema "${schema}": ${(error as Error).message}`),
    });
    this.relay.start();
    this.keepAlive = setInterval(() => undefined, 1 << 30);
    this.logger.log(
      `outbox relay started for schemas: ${this.stores.map((s) => s.schema).join(', ') || '(none)'}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.relay?.stop();
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    await this.bus.close();
  }
}
