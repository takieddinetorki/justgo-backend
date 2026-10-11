import { resolveKind, validateMessage } from './messaging.service';
import type { SendMessageDTO } from '../contract/dto';

describe('resolveKind', () => {
  it('defaults to text', () => {
    expect(resolveKind({ body: 'hello' })).toBe('text');
  });

  it('infers photo from an attachment with no duration', () => {
    expect(resolveKind({ attachmentBucket: 'message-attachments', attachmentPath: 'a/b.jpg' })).toBe(
      'photo',
    );
  });

  it('infers voice from an attachment carrying a duration', () => {
    expect(
      resolveKind({ attachmentBucket: 'message-attachments', attachmentPath: 'a/b.m4a', durationMs: 1200 }),
    ).toBe('voice');
  });

  it('never overrides an explicit kind', () => {
    expect(resolveKind({ kind: 'photo', body: 'caption' })).toBe('photo');
  });
});

describe('validateMessage', () => {
  const attachment: SendMessageDTO = {
    attachmentBucket: 'message-attachments',
    attachmentPath: 'acct/1.jpg',
  };

  it('requires a body on a text message', () => {
    expect(() => validateMessage('text', {})).toThrow(/needs a body/i);
    expect(() => validateMessage('text', { body: '   ' })).toThrow(/needs a body/i);
  });

  it('accepts a normal text message', () => {
    expect(() => validateMessage('text', { body: 'hello' })).not.toThrow();
  });

  it('rejects an over-long body', () => {
    expect(() => validateMessage('text', { body: 'x'.repeat(4001) })).toThrow(/exceed/i);
  });

  it('requires bucket and path on an attachment', () => {
    expect(() => validateMessage('photo', {})).toThrow(/attachmentBucket/);
    expect(() => validateMessage('photo', { attachmentBucket: 'message-attachments' })).toThrow(
      /attachmentPath/,
    );
  });

  /*
    The one that matters. `attachmentBucket` arrives from the client, so
    without an allow-list a sender could address `registrations` and turn
    a chat message into a read handle for somebody's scanned vehicle
    papers.
  */
  it('refuses a bucket that is not for message attachments', () => {
    for (const bucket of ['registrations', 'avatars', 'vehicle-photos', 'part-photos']) {
      expect(() =>
        validateMessage('photo', { attachmentBucket: bucket, attachmentPath: 'x/y.jpg' }),
      ).toThrow(/may not be attached/i);
    }
  });

  it('accepts the message-attachments bucket', () => {
    expect(() => validateMessage('photo', attachment)).not.toThrow();
  });

  it('requires a positive duration on a voice note', () => {
    expect(() => validateMessage('voice', attachment)).toThrow(/durationMs/);
    expect(() => validateMessage('voice', { ...attachment, durationMs: 0 })).toThrow(/durationMs/);
    expect(() => validateMessage('voice', { ...attachment, durationMs: 1500 })).not.toThrow();
  });
});
