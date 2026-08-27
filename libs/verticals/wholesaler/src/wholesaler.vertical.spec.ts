import { assertVerticalSatisfiesCapabilities, VerticalRegistry } from '@justgo/contracts';
import { WholesalerVertical } from './wholesaler.vertical';

describe('WholesalerVertical', () => {
  const vertical = new WholesalerVertical();

  it('satisfies its declared capability contract (§9)', () => {
    expect(() => assertVerticalSatisfiesCapabilities(vertical)).not.toThrow();
  });

  it('is discovered by RECEIVES_PART_REQUESTS alongside other such verticals', () => {
    const registry = new VerticalRegistry([vertical]);
    expect(registry.withCapability('RECEIVES_PART_REQUESTS').map((v) => v.key)).toEqual(['wholesaler']);
    expect(registry.withCapability('B2B_PURCHASING').map((v) => v.key)).toEqual(['wholesaler']);
  });

  it('declares trilingual onboarding fields', () => {
    for (const f of vertical.onboardingSchema().fields) {
      expect(Object.keys(f.labelI18n).sort()).toEqual(['en', 'es', 'fr']);
    }
  });
});
