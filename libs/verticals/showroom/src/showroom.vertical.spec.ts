import { assertVerticalSatisfiesCapabilities, VerticalRegistry } from '@justgo/contracts';
import { ShowroomVertical } from './showroom.vertical';

describe('ShowroomVertical', () => {
  const vertical = new ShowroomVertical();
  it('satisfies its capability contract (LISTS_VEHICLES → catalogueSpec)', () => {
    expect(() => assertVerticalSatisfiesCapabilities(vertical)).not.toThrow();
    expect(vertical.catalogueSpec().kind).toBe('vehicles');
  });
  it('is discovered by LISTS_VEHICLES', () => {
    expect(new VerticalRegistry([vertical]).withCapability('LISTS_VEHICLES').map((v) => v.key)).toEqual(['showroom']);
  });
});
