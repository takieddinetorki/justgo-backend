import { Logger } from '@nestjs/common';

/** One broadcast message: a topic (channel), an event name, and a payload. */
export interface BroadcastMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Transport seam (§4.8). The publisher talks to this, not to HTTP, so the
 * self-hosted Supabase transport can be swapped (or turned into a no-op in
 * tests / infra-less dev) without touching the reactors.
 */
export interface RealtimeSender {
  send(messages: BroadcastMessage[]): Promise<void>;
}

export const REALTIME_SENDER = Symbol('REALTIME_SENDER');

/** Used when no Supabase URL is configured — logs and drops. */
export class NoopRealtimeSender implements RealtimeSender {
  private readonly logger = new Logger('NoopRealtimeSender');
  async send(messages: BroadcastMessage[]): Promise<void> {
    for (const m of messages) {
      this.logger.debug(`realtime (noop) ${m.topic} <- ${m.event}`);
    }
  }
}

export interface SupabaseRealtimeOptions {
  /** Kong gateway base, e.g. http://localhost:8100 */
  supabaseUrl: string;
  /** service_role (or anon) key — sent as the apikey header. */
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Self-hosted Supabase Realtime broadcast via its HTTP API
 * (`POST /realtime/v1/api/broadcast`). Never throws to callers — realtime is
 * best-effort; a transport failure must not roll back a committed state
 * change or fail an event handler.
 */
export class SupabaseRealtimeSender implements RealtimeSender {
  private readonly logger = new Logger('SupabaseRealtimeSender');
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SupabaseRealtimeOptions) {
    this.endpoint = `${opts.supabaseUrl.replace(/\/$/, '')}/realtime/v1/api/broadcast`;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async send(messages: BroadcastMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.opts.apiKey,
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          messages: messages.map((m) => ({
            topic: m.topic,
            event: m.event,
            payload: m.payload,
            private: false,
          })),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`realtime broadcast HTTP ${res.status} for ${messages.length} message(s)`);
      }
    } catch (error) {
      this.logger.warn(`realtime broadcast failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
