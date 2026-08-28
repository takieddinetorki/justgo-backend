import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { REQUESTS_PORT, type RequestsPort } from '@justgo/requests';
import { VEHICLES_PORT, type VehiclesPort } from '@justgo/vehicles';

/**
 * Background schedulers (§8.1 expiry, §1/§13 reminders). Timer-driven, never
 * on the HTTP request path (§17.4). In the monolith these run in the API
 * process; Phase 4 relocates them to the workers process during extraction.
 */
@Injectable()
export class SchedulerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerRunner.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Optional() @Inject(REQUESTS_PORT) private readonly requests: RequestsPort | null,
    @Optional() @Inject(VEHICLES_PORT) private readonly vehicles: VehiclesPort | null,
  ) {}

  onApplicationBootstrap(): void {
    const minute = 60_000;
    if (this.requests) {
      this.every(minute, 'request expiry', () => this.requests!.expireDue());
    }
    if (this.vehicles) {
      this.every(6 * 60 * minute, 'maintenance reminders', () => this.vehicles!.sweepDueMaintenance());
    }
  }

  private every(intervalMs: number, name: string, task: () => Promise<number>): void {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const n = await task();
        if (n > 0) this.logger.log(`${name}: processed ${n}`);
      } catch (error) {
        this.logger.error(`${name} failed: ${(error as Error).message}`);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    this.timers.push(timer);
    this.logger.log(`scheduled ${name} every ${Math.round(intervalMs / 60_000)}m`);
  }

  onApplicationShutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
