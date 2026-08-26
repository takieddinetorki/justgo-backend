import { Inject, Injectable } from '@nestjs/common';
import type { RealtimePort } from '../contract/realtime.port';
import { REALTIME_SENDER, type RealtimeSender } from './realtime-sender';

@Injectable()
export class SupabaseRealtimePublisher implements RealtimePort {
  constructor(@Inject(REALTIME_SENDER) private readonly sender: RealtimeSender) {}

  async publish(
    channel: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.sender.send([{ topic: channel, event, payload }]);
  }
}
