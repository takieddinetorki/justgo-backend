import { decide, describe as describeResult } from './documents.service';
import type { VerificationResult } from '../contract/dto';

/** Runs a result through the real pipeline: verdict first, then wording. */
function answer(partial: Partial<VerificationResult>): VerificationResult {
  const r: VerificationResult = {
    found: true,
    authentic: true,
    verdict: 'exists_unchecked',
    number: 'FA-2026-000014',
    type: 'invoice',
    status: 'issued',
    issuedAt: '2026-11-09T16:27:24.844Z',
    voidedAt: null,
    voidReason: null,
    message: '',
    ...partial,
  };
  r.verdict = decide(r);
  r.message = describeResult(r);
  return r;
}

const WITH_CONTENT = {
  content: {
    totalMinor: 600000,
    currency: 'DZD',
    issuedOn: '2026-11-09',
    issuer: 'SARL Pieces Auto Alger',
    lineCount: 3,
    fields: [],
  },
};

/** A confirmation: no total anywhere, and the facts live in the payload. */
const RESERVATION_CONTENT = {
  content: {
    totalMinor: null,
    currency: null,
    issuedOn: '2026-11-10',
    issuer: null,
    lineCount: null,
    fields: [
      { label: 'Statut', value: 'Confirmee' },
      { label: 'Prestation', value: 'Freinage' },
      { label: 'Rendez-vous', value: '10/11/2026 23:12 - 00:12' },
      { label: 'Vehicule', value: 'Kia Picanto 2010' },
    ],
  },
};

/**
 * The sentence a human holding a printout reads. It has to keep
 * AUTHENTICITY and VALIDITY apart — a voided invoice is still genuinely
 * ours, it simply no longer stands — and it must never claim anything
 * about a page nobody checked.
 */
describe('verification message', () => {
  /*
    THE ATTACK THIS EXISTS FOR. Lift the fingerprint off a genuine 6 000
    DZD facture, print a new page saying 10 000 DZD, keep the same code.
    The lookup finds a real document and our sealed copy IS intact — so
    the old wording, "Authentic and valid: issued by JustGo and
    unaltered", came back and confirmed the forgery to whoever scanned
    it. Nothing cryptographic can prevent the copy; the answer has to
    stop claiming what it does not know, and has to print the real
    figures so the holder can see 6 000 against 10 000.
  */
  it('never claims the holder copy is unaltered when nothing was supplied', () => {
    const r = answer(WITH_CONTENT);
    expect(r.verdict).toBe('exists_unchecked');
    expect(r.message).not.toMatch(/unaltered/i);
    expect(r.message).toMatch(/does NOT confirm the copy you hold/i);
    expect(r.message).toMatch(/anyone can print a fingerprint onto any page/i);
  });

  it('prints the real figures so a copied code can be caught by eye', () => {
    const r = answer(WITH_CONTENT);
    expect(r.message).toMatch(/6000\.00 DZD/);
    expect(r.message).toMatch(/2026-11-09/);
    expect(r.message).toMatch(/SARL Pieces Auto Alger/);
    expect(r.message).toMatch(/3 line\(s\)/);
    expect(r.message).toMatch(/CHECK THOSE AGAINST YOUR COPY/);
  });

  /*
    A reservation confirmation has no total, no currency and no lines.
    The comparison sentence used to collapse to "It is dated the 10th",
    which tells a workshop nothing it could check - so for those the
    answer reads back what the document actually says.
  */
  it('reads back the printed facts when there is no total to compare', () => {
    const r = answer(RESERVATION_CONTENT);
    expect(r.message).toMatch(/Prestation Freinage/);
    expect(r.message).toMatch(/Rendez-vous 10\/11\/2026 23:12/);
    expect(r.message).toMatch(/CHECK THOSE AGAINST YOUR COPY/);
    // And never a total it does not have.
    expect(r.message).not.toMatch(/total/i);
    expect(r.message).not.toMatch(/0\.00/);
  });

  it('is the strongest answer only when a file was supplied and matched', () => {
    const r = answer({ matchesSuppliedFile: true });
    expect(r.verdict).toBe('file_matches');
    expect(r.message).toMatch(/exactly the file JustGo issued/i);
  });

  it('distinguishes an altered copy from no such document', () => {
    const altered = answer({ matchesSuppliedFile: false });
    expect(altered.verdict).toBe('file_altered');
    expect(altered.message).toMatch(/your copy has been altered/i);

    const missing = answer({ found: false, authentic: false });
    expect(missing.verdict).toBe('not_found');
    expect(missing.message).toMatch(/was ever issued by JustGo/i);
  });

  it('says a void document WAS genuinely issued', () => {
    const r = answer({
      status: 'void',
      voidedAt: '2026-11-01T09:00:00.000Z',
      voidReason: 'superseded',
      matchesSuppliedFile: true,
    });
    expect(r.verdict).toBe('void');
    expect(r.message).toMatch(/genuinely issued/i);
    expect(r.message).toMatch(/annulled/i);
    expect(r.message).toMatch(/2026-11-01/);
    // Must NOT read as a forgery.
    expect(r.message).not.toMatch(/falsified|altered/i);
  });

  /*
    Our own stored bytes failing their signature is a different thing
    from a holder's copy being wrong, and it is OUR problem — so it says
    so, instead of implying the holder forged something.
  */
  it('reports a compromised stored copy as ours, not the holder forgery', () => {
    const r = answer({ authentic: false });
    expect(r.verdict).toBe('compromised');
    expect(r.message).toMatch(/our own sealed copy/i);
    expect(r.message).toMatch(/report it/i);
  });

  /*
    Against a document NUMBER there is no content block, because numbers
    are sequential: disclosing figures would let anybody walk a
    business's turnover. The answer is still honest about its limits.
  */
  it('omits the comparison when there is no content to compare', () => {
    const r = answer({});
    expect(r.message).not.toMatch(/CHECK THOSE AGAINST YOUR COPY/);
    expect(r.message).toMatch(/does NOT confirm the copy you hold/i);
  });
});
