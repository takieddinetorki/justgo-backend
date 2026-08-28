import { assertVerticalSatisfiesCapabilities, VerticalRegistry } from '@justgo/contracts';
import { BodyPaintVertical } from './body-paint.vertical';

describe('BodyPaintVertical', () => {
  const vertical = new BodyPaintVertical();

  it('satisfies its declared capability contract (§9)', () => {
    expect(() => assertVerticalSatisfiesCapabilities(vertical)).not.toThrow();
  });

  it('is a bookable-service vertical discoverable by capability', () => {
    const registry = new VerticalRegistry([vertical]);
    expect(registry.withCapability('OFFERS_BOOKABLE_SERVICES').map((x) => x.key)).toEqual(['body_paint']);
    expect(vertical.serviceSpec().serviceTypeKeys.length).toBeGreaterThan(0);
  });

  it('declares trilingual onboarding fields', () => {
    for (const f of vertical.onboardingSchema().fields) {
      expect(Object.keys(f.labelI18n).sort()).toEqual(['en', 'es', 'fr']);
    }
  });
});
