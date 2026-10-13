import {
  assertDriverTransition,
  licenceExpired,
  missingDocuments,
  REQUIRED_DOCUMENTS,
} from './driver-state';

describe('driver verification lifecycle', () => {
  it('walks the happy path', () => {
    expect(assertDriverTransition('draft', 'pending_review')).toBe('pending_review');
    expect(assertDriverTransition('pending_review', 'verified')).toBe('verified');
  });

  it('lets a rejected driver fix the photo and resubmit', () => {
    expect(assertDriverTransition('pending_review', 'rejected')).toBe('rejected');
    expect(assertDriverTransition('rejected', 'pending_review')).toBe('pending_review');
  });

  it('lets a verified driver be suspended and re-reviewed', () => {
    expect(assertDriverTransition('verified', 'suspended')).toBe('suspended');
    expect(assertDriverTransition('suspended', 'pending_review')).toBe('pending_review');
  });

  /*
    The two shortcuts that would matter most: verifying somebody nobody
    looked at, and verifying straight out of suspension without re-checking
    whatever caused it.
  */
  it('refuses to verify a draft that was never submitted', () => {
    expect(() => assertDriverTransition('draft', 'verified')).toThrow(/Cannot move a driver/);
  });

  it('refuses to verify straight out of suspension', () => {
    expect(() => assertDriverTransition('suspended', 'verified')).toThrow();
  });

  it('has no path back to draft', () => {
    for (const from of ['pending_review', 'verified', 'rejected', 'suspended'] as const) {
      expect(() => assertDriverTransition(from, 'draft')).toThrow();
    }
  });

  it('names what is allowed instead', () => {
    try {
      assertDriverTransition('draft', 'verified');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { details: { allowed: string[] } }).details.allowed).toEqual([
        'pending_review',
      ]);
    }
  });
});

describe('the document gate', () => {
  it('demands a licence photo AND a selfie', () => {
    expect(REQUIRED_DOCUMENTS).toContain('licence_front');
    expect(REQUIRED_DOCUMENTS).toContain('selfie');
  });

  it('reports exactly what is still missing', () => {
    expect(missingDocuments([])).toEqual(['licence_front', 'selfie']);
    expect(missingDocuments(['licence_front'])).toEqual(['selfie']);
    expect(missingDocuments(['selfie'])).toEqual(['licence_front']);
    expect(missingDocuments(['licence_front', 'selfie'])).toEqual([]);
  });

  /*
    A licence photo alone would mean "somebody photographed a licence" — not
    that it was their own. The back and an ID card are accepted but do not
    substitute for the selfie.
  */
  it('does not accept extra documents in place of the selfie', () => {
    expect(missingDocuments(['licence_front', 'licence_back', 'id_card'])).toEqual(['selfie']);
  });
});

describe('licenceExpired', () => {
  const today = new Date('2026-10-13T00:00:00Z');

  it('treats unknown as not expired', () => {
    // Missing is not the same as expired: most drivers will not have typed it.
    expect(licenceExpired(null, today)).toBe(false);
  });

  it('compares by day, not by instant', () => {
    expect(licenceExpired('2026-10-13', today)).toBe(false); // expires today, still valid
    expect(licenceExpired('2026-10-12', today)).toBe(true);
    expect(licenceExpired('2031-04-30', today)).toBe(false);
  });
});
