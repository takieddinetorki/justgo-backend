import {
  canonicalJson,
  documentContentHash,
  groupContentHash,
  normaliseContentHash,
} from './content-hash';

const base = {
  number: 'FA-2026-000013',
  type: 'invoice',
  issuedAt: new Date('2026-11-09T16:00:30.297Z'),
  prevSha256: '6b89c31dc3d562790faff1d4e83c1090c10ae32744b2ad1c0bfebf575f6429a4',
  payload: {
    currency: 'DZD',
    buyerName: 'Taki Eddine TORKI',
    lines: [{ description: 'Plaquettes de frein avant', quantity: 1, unitTtcMinor: 850000 }],
  },
};

describe('document content hash', () => {
  it('is a lower-case sha-256 digest', () => {
    expect(documentContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same content', () => {
    expect(documentContentHash(base)).toBe(documentContentHash({ ...base }));
  });

  /*
    THE POINT OF THE WHOLE THING. The printed hash has to change when the
    document changes, or it certifies nothing.
  */
  it('changes on a single character anywhere in the content', () => {
    const original = documentContentHash(base);
    const variants = [
      // one comma's worth of difference in a description
      { ...base, payload: { ...base.payload, lines: [{ ...base.payload.lines[0], description: 'Plaquettes de frein, avant' }] } },
      // one centime
      { ...base, payload: { ...base.payload, lines: [{ ...base.payload.lines[0], unitTtcMinor: 850001 }] } },
      // one letter in the buyer's name
      { ...base, payload: { ...base.payload, buyerName: 'Taki Eddine TORKl' } },
      // a different currency
      { ...base, payload: { ...base.payload, currency: 'EUR' } },
    ];
    for (const v of variants) {
      expect(documentContentHash(v)).not.toBe(original);
    }
  });

  /*
    "No two documents, even identical documents, can have the same hash."
    Two factures saying exactly the same thing still differ by number, by
    issue instant, and by where they sit in the chain.
  */
  it('differs between two documents with identical content', () => {
    const first = documentContentHash(base);
    const sameButNextNumber = documentContentHash({ ...base, number: 'FA-2026-000014' });
    const sameButLater = documentContentHash({
      ...base,
      issuedAt: new Date('2026-11-09T16:00:31.297Z'),
    });
    const sameButElsewhereInChain = documentContentHash({ ...base, prevSha256: 'f'.repeat(64) });
    expect(new Set([first, sameButNextNumber, sameButLater, sameButElsewhereInChain]).size).toBe(4);
  });

  /*
    The payload makes a round trip through jsonb, which does not preserve
    key order. A digest that depended on insertion order would verify at
    issue and fail forever afterwards.
  */
  it('does not depend on key order', () => {
    const reordered = {
      ...base,
      payload: {
        lines: base.payload.lines,
        buyerName: base.payload.buyerName,
        currency: base.payload.currency,
      },
    };
    expect(documentContentHash(reordered)).toBe(documentContentHash(base));
  });

  it('keeps array order, which is not the same thing', () => {
    const two = { ...base, payload: { ...base.payload, lines: [{ a: 1 }, { b: 2 }] } };
    const flipped = { ...base, payload: { ...base.payload, lines: [{ b: 2 }, { a: 1 }] } };
    expect(documentContentHash(two)).not.toBe(documentContentHash(flipped));
  });

  it('canonicalises nested objects, nulls and arrays', () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":null},"b":1}',
    );
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('reading a hash back off paper', () => {
  const hash = '6b89c31dc3d562790faff1d4e83c1090c10ae32744b2ad1c0bfebf575f6429a4';

  it('accepts it in the groups it is printed in, and in upper case', () => {
    const [top, bottom] = groupContentHash(hash);
    expect(top.split(' ')).toHaveLength(4);
    expect(bottom.split(' ')).toHaveLength(4);
    expect(normaliseContentHash(`${top} ${bottom}`)).toBe(hash);
    expect(normaliseContentHash(hash.toUpperCase())).toBe(hash);
    expect(normaliseContentHash(`${top}-${bottom}`)).toBe(hash);
  });

  /*
    null, not a throw and not a silent pass-through: the caller has to be
    able to tell "that is not a fingerprint" from "no such document", and
    a document NUMBER must fall through to the number lookup.
  */
  it('refuses anything that is not a digest', () => {
    expect(normaliseContentHash('FA-2026-000013')).toBeNull();
    expect(normaliseContentHash(hash.slice(0, 63))).toBeNull();
    expect(normaliseContentHash(`${hash}0`)).toBeNull();
    expect(normaliseContentHash('z'.repeat(64))).toBeNull();
    expect(normaliseContentHash('')).toBeNull();
  });
});
