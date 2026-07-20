import { Module, type DynamicModule } from '@nestjs/common';
import { EVENT_BUS, type EventBus } from './event-bus';
import { InMemoryEventBus } from './in-memory';
import { BullMqEventBus } from './bullmq-event-bus';

export interface EventsModuleOptions {
  /** Redis URL enables the BullMQ bus; omit for the in-memory bus (tests/dev). */
  redisUrl?: string;
  queueName?: string;
}

@Module({})
export class EventsModule {
  static forRoot(options: EventsModuleOptions = {}): DynamicModule {
    const bus: EventBus = options.redisUrl
      ? new BullMqEventBus({ redisUrl: options.redisUrl, queueName: options.queueName })
      : new InMemoryEventBus();
    return {
      module: EventsModule,
      global: true,
      providers: [{ provide: EVENT_BUS, useValue: bus }],
      exports: [EVENT_BUS],
    };
  }
}
