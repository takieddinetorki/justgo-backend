import { describe as describeResult } from './documents.service';
import type { VerificationResult } from '../contract/dto';

const base: VerificationResult = {
  found: true,
  authentic: true,
  number: 'RES-2026-000001',
  type: 'reservation_confirmation',
  status: 'issued',
  issuedAt: '2026-10-12T10:00:00.000Z',
  voidedAt: null,
  voidReason: null,
  message: '',
};

/**
 * The sentence a human holding a printout reads. It has to keep
 * AUTHENTICITY and VALIDITY apart — a voided invoice is still genuinely
 * ours, it simply no longer stands, and saying "invalid" for both would
 * make a real document look forged.
 */
describe('verification message', () => {
  it('confirms an authentic, standing document', () => {
    expect(describeResult(base)).toMatch(/authentic and valid/i);
  });

  it('says a void document WAS genuinely issued', () => {
    const msg = describeResult({
      ...base,
      status: 'void',
      voidedAt: '2026-11-01T09:00:00.000Z',
      voidReason: 'superseded',
    });
    expect(msg).toMatch(/genuinely issued/i);
    expect(msg).toMatch(/annulled/i);
    expect(msg).toMatch(/2026-11-01/);
    // Must NOT read as a forgery.
    expect(msg).not.toMatch(/falsified/i);
  });

  it('calls a mismatched document falsified', () => {
    expect(describeResult({ ...base, authentic: false })).toMatch(/falsified/i);
  });

  it('distinguishes "your copy is altered" from "no such document"', () => {
    const altered = describeResult({ ...base, matchesSuppliedFile: false });
    expect(altered).toMatch(/your copy has been altered/i);

    const missing = describeResult({ found: false, authentic: false, message: '' });
    expect(missing).toMatch(/never issued by JustGo|was ever issued/i);
  });

  it('reports an authentic match when the supplied file agrees', () => {
    expect(describeResult({ ...base, matchesSuppliedFile: true })).toMatch(/authentic and valid/i);
  });
});
