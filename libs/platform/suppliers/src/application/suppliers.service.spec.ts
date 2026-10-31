import { BusinessRuleError, newId, type AccountId, type SupplierId } from '@justgo/kernel';
import { VerticalRegistry, type SupplierVertical } from '@justgo/contracts';
import { SuppliersService } from './suppliers.service';
import type { PgSuppliersRepository } from '../infra/pg-suppliers.repository';
import type { RegisterSupplierDTO, SupplierDTO, UpdateSupplierProfileDTO } from '../contract/dto';

const partStore: SupplierVertical = {
  key: 'part_store',
  capabilities: ['RECEIVES_PART_REQUESTS', 'LISTS_PRODUCTS'],
  onboardingSchema: () => ({ fields: [] }),
  profileSchema: () => ({ fields: [] }),
  quoteFor: async () => ({ kind: 'price' }),
  catalogueSpec: () => ({ kind: 'parts', categoryKeys: [] }),
};

class FakeRepo {
  suppliers: SupplierDTO[] = [];
  async insert(ownerAccountId: AccountId, input: RegisterSupplierDTO): Promise<SupplierDTO> {
    const dto: SupplierDTO = {
      id: newId<SupplierId>(),
      ownerAccountId,
      verticalKey: input.verticalKey,
      name: input.name,
      isOpen: true,
      isMultiBranch: false,
      city: input.city ?? null,
      // Fiscal identity starts empty: a new supplier cannot be invoiced
      // until it completes its profile, which is the point.
      address: null,
      legalName: null,
      nif: null,
      nis: null,
      rc: null,
      taxArticle: null,
      country: input.country ?? null,
      description: null,
      phone: null,
      email: null,
      logo: null,
      cover: null,
      hours: null,
      // A brand-new business is unrated and unverified, and both have to
      // stay that way until somebody else acts: a rating is earned from
      // customers, a badge is awarded by JustGo.
      rating: null,
      ratingCount: 0,
      isVerified: false,
      verifiedAt: null,
      closedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.suppliers.push(dto);
    return dto;
  }

  async updateProfile(id: SupplierId, patch: UpdateSupplierProfileDTO): Promise<SupplierDTO | null> {
    const found = this.suppliers.find((s) => s.id === id);
    if (!found) return null;
    // `null` clears, `undefined` leaves alone — the rule the real repository
    // builds its set-list around, mirrored so the test exercises it.
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (found as unknown as Record<string, unknown>)[key] = value;
    }
    return found;
  }

  async close(id: SupplierId): Promise<SupplierDTO | null> {
    const found = this.suppliers.find((s) => s.id === id);
    if (!found) return null;
    found.closedAt = new Date().toISOString();
    found.isOpen = false;
    return found;
  }
  async findById(id: SupplierId): Promise<SupplierDTO | null> {
    return this.suppliers.find((s) => s.id === id) ?? null;
  }
  async findByOwner(owner: AccountId): Promise<SupplierDTO | null> {
    return this.suppliers.find((s) => s.ownerAccountId === owner) ?? null;
  }
  async eligibleForPartRequest(verticalKeys: string[]): Promise<SupplierId[]> {
    return this.suppliers.filter((s) => verticalKeys.includes(s.verticalKey)).map((s) => s.id);
  }
}

describe('SuppliersService', () => {
  const setup = () => {
    const repo = new FakeRepo();
    const service = new SuppliersService(
      repo as unknown as PgSuppliersRepository,
      new VerticalRegistry([partStore]),
    );
    return { repo, service };
  };

  it('registers a supplier under a known vertical', async () => {
    const { service } = setup();
    const owner = newId<AccountId>();
    const supplier = await service.register(owner, { verticalKey: 'part_store', name: 'AutoParts' });
    expect(supplier.verticalKey).toBe('part_store');
    expect(await service.getByOwner(owner)).toEqual(supplier);
  });

  it('rejects unknown verticals with a 422 naming the known ones', async () => {
    const { service } = setup();
    await expect(
      service.register(newId<AccountId>(), { verticalKey: 'spaceship_dealer', name: 'X' }),
    ).rejects.toMatchObject({
      constructor: BusinessRuleError,
      code: 'UNKNOWN_VERTICAL',
      details: { known: ['part_store'] },
    });
  });

  it('rejects a second business for the same account', async () => {
    const { service } = setup();
    const owner = newId<AccountId>();
    await service.register(owner, { verticalKey: 'part_store', name: 'First' });
    await expect(
      service.register(owner, { verticalKey: 'part_store', name: 'Second' }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_ALREADY_REGISTERED' });
  });

  it('updates a profile, clearing only what was explicitly nulled', async () => {
    const { service } = setup();
    const owner = newId<AccountId>();
    const supplier = await service.register(owner, {
      verticalKey: 'part_store',
      name: 'AutoParts',
      city: 'Alger',
    });
    const updated = await service.updateProfile(supplier.id, {
      description: 'Pieces detachees',
      city: null,
    });
    expect(updated.description).toBe('Pieces detachees');
    expect(updated.city).toBeNull();
    // Untouched fields stay untouched — a PATCH is not a replace.
    expect(updated.name).toBe('AutoParts');
  });

  it('refuses to edit a business that has been closed', async () => {
    const { service } = setup();
    const owner = newId<AccountId>();
    const supplier = await service.register(owner, { verticalKey: 'part_store', name: 'A' });
    await service.close(supplier.id);
    await expect(service.updateProfile(supplier.id, { name: 'B' })).rejects.toMatchObject({
      code: 'SUPPLIER_CLOSED',
    });
  });

  it('rejects opening hours that end before they start', async () => {
    const { service } = setup();
    const owner = newId<AccountId>();
    const supplier = await service.register(owner, { verticalKey: 'part_store', name: 'A' });
    await expect(
      service.updateProfile(supplier.id, { hours: { mon: [{ from: '18:00', to: '09:00' }] } }),
    ).rejects.toThrow(/ends before it starts/);
  });

  it('targets eligible suppliers by vertical', async () => {
    const { service } = setup();
    const owner = newId<AccountId>();
    const supplier = await service.register(owner, { verticalKey: 'part_store', name: 'A' });
    await expect(service.eligibleForPartRequest(['part_store'], null)).resolves.toEqual([
      supplier.id,
    ]);
    await expect(service.eligibleForPartRequest(['workshop'], null)).resolves.toEqual([]);
  });
});
