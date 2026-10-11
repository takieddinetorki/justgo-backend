import { DiscoveryService } from './discovery.service';
import type { DirectoryQuery, DirectorySupplierDTO } from '../contract/dto';
import type { PgDiscoveryRepository } from '../infra/pg-discovery.repository';

const row = (name: string, over: Partial<DirectorySupplierDTO> = {}): DirectorySupplierDTO =>
  ({
    supplierId: '11111111-1111-4111-8111-111111111111',
    verticalKey: 'workshop',
    name,
    categoryKeys: [],
    city: 'Alger',
    country: 'DZ',
    rating: null,
    ...over,
  }) as DirectorySupplierDTO;

function repoDouble(rows: DirectorySupplierDTO[], hasMore = false) {
  const calls: Array<{ query: DirectoryQuery; limit: number }> = [];
  const repo = {
    directory: async (query: DirectoryQuery, limit: number) => {
      calls.push({ query, limit });
      return { rows, hasMore };
    },
    cursorFor: (r: DirectorySupplierDTO) => `cursor:${r.name}`,
    getSupplier: async () => rows[0] ?? null,
  } as unknown as PgDiscoveryRepository;
  return { repo, calls };
}

describe('DiscoveryService.directory', () => {
  it('browses with no location at all — the point of the directory', async () => {
    const { repo, calls } = repoDouble([row('Garage Benali')]);
    const page = await new DiscoveryService(repo).directory({});

    expect(page.items).toHaveLength(1);
    expect(calls[0]?.query.lat).toBeUndefined();
  });

  it('rejects one coordinate without the other', async () => {
    const { repo } = repoDouble([]);
    const svc = new DiscoveryService(repo);
    // Silently ignoring a lone lat would look like the sort was broken.
    await expect(svc.directory({ lat: 36.75 })).rejects.toThrow(/together/i);
    await expect(svc.directory({ lng: 3.06 })).rejects.toThrow(/together/i);
  });

  it('rejects out-of-range coordinates', async () => {
    const { repo } = repoDouble([]);
    const svc = new DiscoveryService(repo);
    await expect(svc.directory({ lat: 91, lng: 3 })).rejects.toThrow(/lat/i);
    await expect(svc.directory({ lat: 36, lng: 181 })).rejects.toThrow(/lng/i);
  });

  it('caps the page size', async () => {
    const { repo, calls } = repoDouble([]);
    await new DiscoveryService(repo).directory({ limit: 5000 });
    expect(calls[0]?.limit).toBe(100);
  });

  it('returns a cursor only when more rows exist', async () => {
    const withMore = repoDouble([row('A'), row('B')], true);
    expect((await new DiscoveryService(withMore.repo).directory({})).nextCursor).toBe('cursor:B');

    const lastPage = repoDouble([row('A')], false);
    expect((await new DiscoveryService(lastPage.repo).directory({})).nextCursor).toBeNull();
  });

  /*
    The geo path ranks by distance, so a (name, id) keyset would skip rows
    arbitrarily. Paging there needs a different cursor; offering a broken
    one is worse than offering none.
  */
  it('offers no cursor on the distance-ranked path', async () => {
    const { repo } = repoDouble([row('A'), row('B')], true);
    const page = await new DiscoveryService(repo).directory({ lat: 36.75, lng: 3.06 });
    expect(page.nextCursor).toBeNull();
  });

  it('passes a single vertical through as a key list', async () => {
    const { repo, calls } = repoDouble([]);
    await new DiscoveryService(repo).directory({ verticalKeys: ['body_paint'] });
    expect(calls[0]?.query.verticalKeys).toEqual(['body_paint']);
  });
});
