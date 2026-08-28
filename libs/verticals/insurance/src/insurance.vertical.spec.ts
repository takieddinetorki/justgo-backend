import { assertVerticalSatisfiesCapabilities, VerticalRegistry } from '@justgo/contracts';
import { InsuranceVertical } from './insurance.vertical';

describe('InsuranceVertical', () => {
  const vertical = new InsuranceVertical();
  it('satisfies its capability contract (publish-only, no required hooks)', () => {
    expect(() => assertVerticalSatisfiesCapabilities(vertical)).not.toThrow();
  });
  it('is discovered by PUBLISHES_POLICIES / PUBLISHES_OFFERS', () => {
    const r = new VerticalRegistry([vertical]);
    expect(r.withCapability('PUBLISHES_POLICIES').map((v) => v.key)).toEqual(['insurance']);
    expect(r.withCapability('PUBLISHES_OFFERS').map((v) => v.key)).toEqual(['insurance']);
  });
});
