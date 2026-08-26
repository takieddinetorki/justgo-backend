import { Module, type DynamicModule } from '@nestjs/common';
import { REALTIME_PORT } from './contract/realtime.port';
import { SupabaseRealtimePublisher } from './infra/supabase-realtime.publisher';
import {
  NoopRealtimeSender,
  REALTIME_SENDER,
  SupabaseRealtimeSender,
} from './infra/realtime-sender';

export interface RealtimeModuleOptions {
  supabaseUrl?: string;
  apiKey?: string;
}

/**
 * Provides RealtimePort. With a Supabase URL + key it broadcasts over the
 * self-hosted Realtime HTTP API; otherwise it no-ops (tests, bare dev).
 * Global so any crosscutting reactor can inject it.
 */
@Module({})
export class RealtimeModule {
  static forRoot(options: RealtimeModuleOptions = {}): DynamicModule {
    const sender =
      options.supabaseUrl && options.apiKey
        ? new SupabaseRealtimeSender({ supabaseUrl: options.supabaseUrl, apiKey: options.apiKey })
        : new NoopRealtimeSender();
    return {
      module: RealtimeModule,
      global: true,
      providers: [
        { provide: REALTIME_SENDER, useValue: sender },
        { provide: REALTIME_PORT, useClass: SupabaseRealtimePublisher },
      ],
      exports: [REALTIME_PORT],
    };
  }
}
