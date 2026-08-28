import { assertVerticalSatisfiesCapabilities, VerticalRegistry } from '@justgo/contracts';
import { RoadsideVertical } from './roadside.vertical';

describe('RoadsideVertical', () => {
  const vertical = new RoadsideVertical();
  it('satisfies its capability contract (PROVIDES_DISPATCH -> dispatchSpec)', () => {
    expect(() => assertVerticalSatisfiesCapabilities(vertical)).not.toThrow();
    expect(vertical.dispatchSpec().maxRadiusKm).toBeGreaterThan(0);
  });
  it('is discovered by PROVIDES_DISPATCH', () => {
    expect(new VerticalRegistry([vertical]).withCapability('PROVIDES_DISPATCH').map((v) => v.key)).toEqual(['roadside']);
  });
  it('carries a custom driver+truck profile', () => {
    expect(vertical.profileSchema().fields.map((f) => f.key)).toEqual(expect.arrayContaining(['driver_name', 'truck_plate']));
  });
});
