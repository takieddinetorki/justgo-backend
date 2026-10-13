import type { AccountId, Uuid } from '@justgo/kernel';
import { SocialService } from './social.service';
import type { PgSocialRepository } from '../infra/pg-social.repository';

/*
  These cover the checks that stand between a public feed and the two things
  it must never allow: an author speaking under someone else's business name,
  and an author attaching someone else's upload. Neither is visible to a type
  checker, and both are the kind of hole that is only noticed from the outside.
*/

const CALLER = 'acc-1' as unknown as AccountId;
const POST_ID = 'post-1' as unknown as Uuid;

function harness() {
  const published: unknown[] = [];
  const repo = {
    publish: async (caller: AccountId, input: unknown) => {
      published.push({ caller, input });
      return { id: POST_ID } as never;
    },
    isPublished: async () => true,
    listComments: async () => ({ items: [], nextCursor: null }),
    comment: async (_c: AccountId, _p: Uuid, input: { body: string }) =>
      ({ body: input.body }) as never,
    remove: async (_p: Uuid, reason: string) => ({ reason }) as never,
  } as unknown as PgSocialRepository;
  return { service: new SocialService(repo), published };
}

const photo = (overrides: Record<string, unknown> = {}) => ({
  kind: 'photo' as const,
  bucket: 'post-media',
  path: `${CALLER}/1.jpg`,
  ...overrides,
});

describe('SocialService.publish', () => {
  it('accepts a text post', async () => {
    const { service, published } = harness();
    await service.publish(CALLER, { body: 'Bonjour' });
    expect(published).toHaveLength(1);
  });

  it('accepts a post that is only media', async () => {
    const { service, published } = harness();
    await service.publish(CALLER, { media: [photo()] });
    expect(published).toHaveLength(1);
  });

  it('refuses a post that says nothing at all', async () => {
    const { service } = harness();
    await expect(service.publish(CALLER, {})).rejects.toThrow();
    await expect(service.publish(CALLER, { body: '   ' })).rejects.toThrow();
  });

  /*
    The uploader namespaces every object under the caller's account id. Without
    this check an author could paste somebody else's upload path — a scanned
    carte grise, a private photo — into a post on a public feed.
  */
  it("refuses somebody else's upload path", async () => {
    const { service } = harness();
    await expect(
      service.publish(CALLER, { media: [photo({ path: 'another-account/1.jpg' })] }),
    ).rejects.toThrow(/your own uploads/i);
  });

  /*
    An allow-list, not a free string. `registrations` holds scanned vehicle
    papers; a post pointing at it would turn the feed into a read handle for
    them.
  */
  it('refuses a bucket that is not for posts', async () => {
    const { service } = harness();
    for (const bucket of ['registrations', 'avatars', 'documents', 'message-attachments']) {
      await expect(
        service.publish(CALLER, { media: [photo({ bucket })] }),
      ).rejects.toThrow(/bucket/i);
    }
  });

  it('refuses durationMs on a photo', async () => {
    const { service } = harness();
    await expect(
      service.publish(CALLER, { media: [photo({ durationMs: 1000 })] }),
    ).rejects.toThrow(/video/i);
  });

  it('allows durationMs on a video', async () => {
    const { service, published } = harness();
    await service.publish(CALLER, {
      media: [photo({ kind: 'video', path: `${CALLER}/clip.mp4`, durationMs: 4200 })],
    });
    expect(published).toHaveLength(1);
  });

  it('caps the number of items', async () => {
    const { service } = harness();
    const many = Array.from({ length: 11 }, (_, i) => photo({ path: `${CALLER}/${i}.jpg` }));
    await expect(service.publish(CALLER, { media: many })).rejects.toThrow(/at most/i);
  });

  it('caps the body length', async () => {
    const { service } = harness();
    await expect(service.publish(CALLER, { body: 'x'.repeat(5001) })).rejects.toThrow(/exceed/i);
  });
});

describe('SocialService.comment', () => {
  it('trims and keeps the body', async () => {
    const { service } = harness();
    const out = await service.comment(CALLER, POST_ID, { body: '  salut  ' });
    expect(out).toMatchObject({ body: 'salut' });
  });

  it('refuses an empty comment', async () => {
    const { service } = harness();
    await expect(service.comment(CALLER, POST_ID, { body: '   ' })).rejects.toThrow();
  });

  it('caps the comment length', async () => {
    const { service } = harness();
    await expect(
      service.comment(CALLER, POST_ID, { body: 'x'.repeat(2001) }),
    ).rejects.toThrow(/exceed/i);
  });
});

describe('SocialService takedown', () => {
  it('requires a reason', async () => {
    const { service } = harness();
    await expect(service.removeAsAdmin(POST_ID, '  ')).rejects.toThrow(/reason/i);
  });

  it('records the reason it was given', async () => {
    const { service } = harness();
    await expect(service.removeAsAdmin(POST_ID, 'Spam')).resolves.toMatchObject({
      reason: 'Spam',
    });
  });
});
