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
 * Runs the outbox relay loop (§12) and a wildcard demo consumer so the
 * Phase 0 pipeline is observable end-to-end in logs.
 */
@Injectable()
export class OutboxRelayRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayRunner.name);
  private relay: OutboxRelay | null = null;

  constructor(
    @Inject(OUTBOX_STORE) private readonly stores: OutboxStore[],
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe('*', async (event) => {
      this.logger.log(`event ${event.type} (${event.id}) consumed`);
    });
    this.relay = new OutboxRelay(this.stores, this.bus, {
      pollIntervalMs: Number(process.env['OUTBOX_POLL_MS'] ?? 500),
      onError: (error, schema) =>
        this.logger.error(`relay failed for schema "${schema}": ${(error as Error).message}`),
    });
    this.relay.start();
    this.logger.log(
      `outbox relay started for schemas: ${this.stores.map((s) => s.schema).join(', ') || '(none)'}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.relay?.stop();
    await this.bus.close();
  }
}
