/**
 * Phase 3 DoD (§19): "adding a 9th vertical touches zero core files — prove
 * with a throwaway tire-center." This test defines a brand-new vertical
 * INLINE (no platform/core change) and shows the capability model routes it
 * exactly like the eight real ones. The only real-world touch point to
 * enable it would be one line in the app's verticals manifest (§9).
 */
import {
  assertVerticalSatisfiesCapabilities,
  VerticalRegistry,
  type Capability,
  type SupplierVertical,
} from '../index';

const label = (s: string) => ({ en: s, es: s, fr: s });

/** A 9th vertical invented purely for this test — the core never names it. */
class TireCenterVertical implements SupplierVertical {
  readonly key = 'tire_center';
  readonly capabilities: Capability[] = [
    'RECEIVES_PART_REQUESTS',
    'LISTS_PRODUCTS',
    'OFFERS_BOOKABLE_SERVICES',
    'HAS_CALENDAR',
  ];
  onboardingSchema() {
    return { fields: [{ key: 'name', type: 'text' as const, labelI18n: label('Name'), required: true }] };
  }
  profileSchema() {
    return { fields: [] };
  }
  async quoteFor() {
    return { kind: 'price' as const };
  }
  catalogueSpec() {
    return { kind: 'parts' as const, categoryKeys: ['tyres'] };
  }
  serviceSpec() {
    return { serviceTypeKeys: ['tyre_fitting', 'wheel_alignment'], requiresVehicle: true };
  }
}

describe('adding a 9th vertical touches zero core files (§19)', () => {
  const tireCenter = new TireCenterVertical();

  it('satisfies every capability contract it declares', () => {
    expect(() => assertVerticalSatisfiesCapabilities(tireCenter)).not.toThrow();
  });

  it('is routed by the same capability queries the core already uses', () => {
    // registered alongside stand-ins for the existing verticals
    const partStore: SupplierVertical = {
      key: 'part_store',
      capabilities: ['RECEIVES_PART_REQUESTS', 'LISTS_PRODUCTS'],
      onboardingSchema: () => ({ fields: [] }),
      profileSchema: () => ({ fields: [] }),
      quoteFor: async () => ({ kind: 'price' }),
      catalogueSpec: () => ({ kind: 'parts', categoryKeys: [] }),
    };
    const registry = new VerticalRegistry([partStore, tireCenter]);

    // the fan-out query the Quote Engine runs picks up the new vertical with
    // no code change in the engine
    expect(registry.withCapability('RECEIVES_PART_REQUESTS').map((v) => v.key).sort()).toEqual([
      'part_store',
      'tire_center',
    ]);
    // and it participates in bookable-service routing too
    expect(registry.withCapability('OFFERS_BOOKABLE_SERVICES').map((v) => v.key)).toEqual([
      'tire_center',
    ]);
    expect(registry.byKey('tire_center')).toBe(tireCenter);
  });
});
