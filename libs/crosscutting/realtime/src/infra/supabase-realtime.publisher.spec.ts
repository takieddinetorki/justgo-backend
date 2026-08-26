import { SupabaseRealtimePublisher } from './supabase-realtime.publisher';
import { NoopRealtimeSender, type BroadcastMessage, type RealtimeSender } from './realtime-sender';
import { requestChannel, supplierChannel } from '../contract/realtime.port';

class CapturingSender implements RealtimeSender {
  sent: BroadcastMessage[] = [];
  async send(messages: BroadcastMessage[]): Promise<void> {
    this.sent.push(...messages);
  }
}

describe('SupabaseRealtimePublisher', () => {
  it('forwards one broadcast message to the sender', async () => {
    const sender = new CapturingSender();
    const pub = new SupabaseRealtimePublisher(sender);
    await pub.publish(requestChannel('req-1'), 'QuoteSubmitted', { amountMinor: 9500 });
    expect(sender.sent).toEqual([
      { topic: 'request:req-1', event: 'QuoteSubmitted', payload: { amountMinor: 9500 } },
    ]);
  });

  it('builds stable channel names', () => {
    expect(requestChannel('r')).toBe('request:r');
    expect(supplierChannel('s')).toBe('supplier:s');
  });

  it('noop sender swallows without throwing', async () => {
    await expect(new NoopRealtimeSender().send([])).resolves.toBeUndefined();
  });
});
