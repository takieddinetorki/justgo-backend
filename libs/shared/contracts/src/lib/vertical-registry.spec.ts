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

/*
  Regression: SWC's loose downlevel rewrote `[...map.values()]` in `all()`
  as `[].concat(iterator)`, so the registry returned a single MapIterator
  instead of the verticals. Every `.key` and `.capabilities` was undefined,
  which broke fan-out ("Cannot read properties of undefined") and supplier
  registration (`UNKNOWN_VERTICAL {"known":[null]}`) at the same time.

  These assert the SHAPE of what comes back, not just the count — a
  length check alone passes with one iterator in the array.
*/
describe('VerticalRegistry.all() returns verticals, not an iterator', () => {
  const vertical = (key: string, capabilities: string[]) =>
    ({ key, capabilities, label: key }) as unknown as SupplierVertical;

  it('yields one entry per registered vertical, each with a usable key', () => {
    const registry = new VerticalRegistry([
      vertical('part_store', ['RECEIVES_PART_REQUESTS']),
      vertical('workshop', ['BOOKS_SERVICES']),
    ]);

    const all = registry.all();
    expect(all).toHaveLength(2);
    expect(all.map((v) => v.key).sort()).toEqual(['part_store', 'workshop']);
    for (const v of all) {
      expect(typeof v.key).toBe('string');
      expect(Array.isArray(v.capabilities)).toBe(true);
    }
  });

  it('filters by capability without throwing on an undefined member', () => {
    const registry = new VerticalRegistry([
      vertical('part_store', ['RECEIVES_PART_REQUESTS']),
      vertical('showroom', ['LISTS_VEHICLES']),
    ]);

    const capable = registry.withCapability('RECEIVES_PART_REQUESTS' as never);
    expect(capable.map((v) => v.key)).toEqual(['part_store']);
  });

  it('is empty, not a one-element iterator, when nothing is registered', () => {
    expect(new VerticalRegistry([]).all()).toEqual([]);
  });
});
