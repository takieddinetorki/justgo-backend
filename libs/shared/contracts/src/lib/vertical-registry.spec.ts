import {
  assertVerticalSatisfiesCapabilities,
  DuplicateVerticalError,
  UnknownVerticalError,
  VerticalRegistry,
} from './vertical-registry';
import type { SupplierVertical } from './verticals';

const emptySchema = () => ({ fields: [] });

const partStore: SupplierVertical = {
  key: 'part_store',
  capabilities: ['RECEIVES_PART_REQUESTS', 'LISTS_PRODUCTS', 'HAS_DELIVERY', 'HAS_DEALS'],
  onboardingSchema: emptySchema,
  profileSchema: emptySchema,
  quoteFor: async () => ({ kind: 'price' }),
  catalogueSpec: () => ({ kind: 'parts', categoryKeys: ['braking'] }),
};

const workshop: SupplierVertical = {
  key: 'workshop',
  capabilities: ['OFFERS_BOOKABLE_SERVICES', 'HAS_CALENDAR', 'INSTALLS_PARTS'],
  onboardingSchema: emptySchema,
  profileSchema: emptySchema,
  serviceSpec: () => ({ serviceTypeKeys: ['oil_change'], requiresVehicle: true }),
};

describe('VerticalRegistry', () => {
  const registry = new VerticalRegistry([partStore, workshop]);

  it('filters by capability — core never names a vertical', () => {
    expect(
      registry.withCapability('RECEIVES_PART_REQUESTS').map((v: SupplierVertical) => v.key),
    ).toEqual(['part_store']);
    expect(registry.withCapability('HAS_CALENDAR').map((v: SupplierVertical) => v.key)).toEqual([
      'workshop',
    ]);
    expect(registry.withCapability('PROVIDES_DISPATCH')).toEqual([]);
  });

  it('resolves by key and rejects unknown keys', () => {
    expect(registry.byKey('workshop').key).toBe('workshop');
    expect(registry.has('nope')).toBe(false);
    expect(() => registry.byKey('nope')).toThrow(UnknownVerticalError);
  });

  it('rejects duplicate registrations', () => {
    expect(() => new VerticalRegistry([partStore, partStore])).toThrow(DuplicateVerticalError);
  });

  it('tolerates an empty workspace (no verticals registered yet)', () => {
    expect(new VerticalRegistry(null).all()).toEqual([]);
  });
});

describe('assertVerticalSatisfiesCapabilities', () => {
  it('passes for a vertical whose hooks back its capabilities', () => {
    expect(() => assertVerticalSatisfiesCapabilities(partStore)).not.toThrow();
    expect(() => assertVerticalSatisfiesCapabilities(workshop)).not.toThrow();
  });

  it('fails when a declared capability has no backing hook', () => {
    const broken: SupplierVertical = {
      key: 'broken',
      capabilities: ['RECEIVES_PART_REQUESTS'],
      onboardingSchema: emptySchema,
      profileSchema: emptySchema,
      // quoteFor missing
    };
    expect(() => assertVerticalSatisfiesCapabilities(broken)).toThrow(/quoteFor/);
  });
});
