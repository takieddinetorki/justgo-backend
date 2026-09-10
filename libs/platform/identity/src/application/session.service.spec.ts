import type { Uuid } from '@justgo/kernel';
import type { SupplierScopeDTO } from '../contract/dto';
import { expiryFor, selectScope } from './session.service';

const scope = (id: string, roleKey = 'supplier_owner'): SupplierScopeDTO => ({
  supplierId: id as Uuid,
  branchId: null,
  roleKey,
});

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('selectScope', () => {
  it('returns no scope for a plain client session', () => {
    expect(selectScope({}, [scope(A)])).toBeNull();
  });

  /*
    The regression this guards: auto-scoping would flip a client's
    GET /v1/orders to the supplier feed the day they registered a
    business, without them asking for it.
  */
  it('does not scope just because the account owns a supplier', () => {
    expect(selectScope({ scope: 'client' }, [scope(A)])).toBeNull();
  });

  it('auto-selects the only supplier when one is asked for', () => {
    expect(selectScope({ scope: 'supplier' }, [scope(A)])?.supplierId).toBe(A);
  });

  it('refuses to guess between several suppliers', () => {
    expect(() => selectScope({ scope: 'supplier' }, [scope(A), scope(B)])).toThrow(
      /name one/i,
    );
  });

  it('rejects a supplier the account holds no role on', () => {
    expect(() => selectScope({ supplierId: B }, [scope(A)])).toThrow(/no supplier role/i);
  });

  it('rejects a supplier session for an account with none', () => {
    expect(() => selectScope({ scope: 'supplier' }, [])).toThrow(/no supplier role/i);
  });

  it('honours an explicit supplier the account does hold', () => {
    expect(selectScope({ supplierId: B }, [scope(A), scope(B)])?.supplierId).toBe(B);
  });

  it('carries a requested branch onto the chosen scope', () => {
    const branch = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(selectScope({ supplierId: A, branchId: branch }, [scope(A)])?.branchId).toBe(branch);
  });
});

describe('expiryFor', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('uses our TTL when the upstream token outlives it', () => {
    expect(expiryFor(3600, now() + 7200)).toBeCloseTo(now() + 3600, -1);
  });

  /*
    The security property: a session must not outlive the authentication
    it was minted from, or an expired GoTrue session keeps working through
    a token we issued and the refresh cycle stops being a control.
  */
  it('never outlives the token it was minted from', () => {
    const upstream = now() + 60;
    expect(expiryFor(3600, upstream)).toBe(upstream);
  });

  it('falls back to our TTL when upstream has no exp', () => {
    expect(expiryFor(900, undefined)).toBeCloseTo(now() + 900, -1);
  });
});
