import { newId, ValidationError, type AccountId, type SupplierId, type Uuid } from '@justgo/kernel';
import { ReviewsService } from './reviews.service';
import type { PgReviewsRepository } from '../infra/pg-reviews.repository';
import type { CreateReviewDTO, ReviewDTO, UpdateReviewDTO } from '../contract/dto';

/**
 * The repository is a stub here on purpose: the rules this file is about —
 * what a rating may be, what a reply may say, whether a retraction carries a
 * reason — are decided before any SQL runs, and a database would only make
 * them slower to assert.
 *
 * The rules that CANNOT be tested here, because they are the database's own,
 * are the ones the live smoke test covers: the eligibility gate, the unique
 * index behind ALREADY_REVIEWED, and the average moving in the same
 * transaction as the review.
 */
class StubRepo {
  calls: { method: string; args: unknown[] }[] = [];

  private record(method: string, ...args: unknown[]): ReviewDTO {
    this.calls.push({ method, args });
    return {
      id: newId<Uuid>(),
      supplierId: newId<SupplierId>(),
      authorAccountId: newId<AccountId>(),
      rating: 5,
      body: null,
      status: 'published',
      source: 'order',
      reply: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async write(s: SupplierId, a: AccountId, input: CreateReviewDTO): Promise<ReviewDTO> {
    return this.record('write', s, a, input);
  }
  async edit(id: Uuid, a: AccountId, patch: UpdateReviewDTO): Promise<ReviewDTO> {
    return this.record('edit', id, a, patch);
  }
  async remove(id: Uuid, reason: string, a?: AccountId): Promise<ReviewDTO> {
    return this.record('remove', id, reason, a);
  }
  async reply(id: Uuid, s: SupplierId, a: AccountId, body: string): Promise<ReviewDTO> {
    return this.record('reply', id, s, a, body);
  }
}

describe('ReviewsService', () => {
  const setup = () => {
    const repo = new StubRepo();
    return { repo, service: new ReviewsService(repo as unknown as PgReviewsRepository) };
  };

  it('rejects a rating outside 1–5', async () => {
    const { service } = setup();
    for (const rating of [0, 6, -1]) {
      await expect(
        service.write(newId<SupplierId>(), newId<AccountId>(), { rating }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it('rejects a half star', async () => {
    // Two scales — some clients sending 4.5, some 4 — would make the average
    // depend on which app you used.
    const { service } = setup();
    await expect(
      service.write(newId<SupplierId>(), newId<AccountId>(), { rating: 4.5 }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts a star with no words', async () => {
    const { repo, service } = setup();
    await service.write(newId<SupplierId>(), newId<AccountId>(), { rating: 4 });
    expect(repo.calls[0].method).toBe('write');
  });

  it('retraction is author-scoped and needs no reason', async () => {
    const { repo, service } = setup();
    const author = newId<AccountId>();
    await service.retract(newId<Uuid>(), author);
    const call = repo.calls[0];
    expect(call.method).toBe('remove');
    // The author id is passed through as the guard — without it this would be
    // an administrative takedown wearing a user's clothes.
    expect(call.args[2]).toBe(author);
  });

  it('a takedown needs a reason and is NOT author-scoped', async () => {
    const { repo, service } = setup();
    await expect(service.takedown(newId<Uuid>(), '   ')).rejects.toThrow(ValidationError);
    await service.takedown(newId<Uuid>(), 'defamatory');
    const call = repo.calls[0];
    expect(call.args[1]).toBe('defamatory');
    expect(call.args[2]).toBeUndefined();
  });

  it('a reply must say something', async () => {
    const { service } = setup();
    await expect(
      service.reply(newId<Uuid>(), newId<SupplierId>(), newId<AccountId>(), '   '),
    ).rejects.toThrow(ValidationError);
  });

  it('an edit may change the rating alone, or the body alone', async () => {
    const { repo, service } = setup();
    await service.edit(newId<Uuid>(), newId<AccountId>(), { rating: 2 });
    await service.edit(newId<Uuid>(), newId<AccountId>(), { body: null });
    expect(repo.calls.map((c) => c.method)).toEqual(['edit', 'edit']);
    // `body: null` has to survive as null and not become undefined, or
    // clearing the text of a review would silently do nothing.
    expect((repo.calls[1].args[2] as UpdateReviewDTO).body).toBeNull();
  });
});
