import { assertVerticalSatisfiesCapabilities, VerticalRegistry } from '@justgo/contracts';
import { newId, type RequestId, type SupplierId } from '@justgo/kernel';
import { PartStoreVertical } from './part-store.vertical';

describe('PartStoreVertical', () => {
  const vertical = new PartStoreVertical();

  it('satisfies its declared capability contract (§9)', () => {
    expect(() => assertVerticalSatisfiesCapabilities(vertical)).not.toThrow();
  });

  it('registers and is discoverable by capability', () => {
    const registry = new VerticalRegistry([vertical]);
    expect(registry.withCapability('RECEIVES_PART_REQUESTS').map((v) => v.key)).toEqual([
      'part_store',
    ]);
    expect(registry.byKey('part_store')).toBe(vertical);
  });

  it('declares trilingual onboarding fields', () => {
    for (const field of vertical.onboardingSchema().fields) {
      expect(Object.keys(field.labelI18n).sort()).toEqual(['en', 'es', 'fr']);
    }
  });

  it('drafts a price quote without auto-committing an amount', async () => {
    const draft = await vertical.quoteFor(
      { supplierId: newId<SupplierId>(), branchId: null, locale: 'en' },
      {
        id: newId<RequestId>(),
        clientAccountId: newId(),
        vehicleId: null,
        tecdocArticleId: 123456,
        categoryKey: 'braking',
        freeText: null,
        photoUrl: null,
        quantity: 1,
        strategy: 'all',
        targetSupplierId: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      },
    );
    expect(draft.kind).toBe('price');
    expect(draft.amount).toBeUndefined(); // pricing is the supplier's decision
  });
});
