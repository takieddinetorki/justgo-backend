import { DocumentsService } from './documents.service';
import { sha256Hex } from '../infra/ed25519-signer';

/**
 * A scan has to lead somewhere.
 *
 * The QR on a reservation confirmation is, in practice, a navigation
 * token: the workshop scanning it wants the booking on screen with the
 * car and the customer, not a verdict. The answer therefore carries
 * `subject` — what the document is ABOUT — and the app routes on it.
 *
 * It is a pointer and nothing more. Following it still requires a token
 * the owning endpoint accepts, so an anonymous scanner learns a UUID.
 * And it is disclosed on the same terms as the figures: fingerprint
 * lookups only, never against a sequential document number, or the
 * series could be walked into a list of everything a business has
 * booked.
 */

const BYTES = Buffer.from('%PDF-1.7 a sealed confirmation');

const DOC = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'reservation_confirmation',
  number: 'RES-2026-000014',
  subjectType: 'reservation',
  subjectId: '4d2fa9fb-e168-4f54-9030-2bd10b973a0c',
  issuedToAccountId: '4ab5bb55-1119-4714-ab19-048aa347e8c6',
  supplierId: '9dcd8e25-ac91-4032-93d6-a4d702f1dead',
  status: 'issued',
  sha256: sha256Hex(BYTES),
  contentHash: 'a'.repeat(64),
  algo: 'ed25519',
  keyId: 'k1',
  signatureFormat: 'detached',
  byteSize: BYTES.length,
  issuedAt: '2026-11-10T07:12:00.000Z',
  voidedAt: null,
  voidReason: null,
  bucket: 'documents',
  path: 'res/RES-2026-000014.pdf',
  signature: 'sig',
  format: 'detached',
  payloadSnapshot: {
    Statut: 'Confirmee',
    Prestataire: 'Garage Walid',
    Client: 'Riyad Benali',
    Prestation: 'Freinage',
    'Rendez-vous': '10/11/2026 23:12 - 00:12',
    Reservation: '4d2fa9fb-e168-4f54-9030-2bd10b973a0c',
  },
};

function service(overrides: { byContentHash?: unknown; byNumber?: unknown } = {}) {
  // `in`, not `??`: the interesting case passes null deliberately.
  const repo = {
    byContentHash: jest.fn(async () =>
      'byContentHash' in overrides ? overrides.byContentHash : DOC,
    ),
    byNumber: jest.fn(async () => ('byNumber' in overrides ? overrides.byNumber : DOC)),
  };
  const signer = { verify: jest.fn(async () => true), publicKeys: () => [] };
  const media = { getObject: jest.fn(async () => BYTES) };
  return new DocumentsService(repo as never, signer as never, media as never, {
    bucket: 'documents',
    verifyBaseUrl: 'http://api.test/v1/documents/verify',
  });
}

describe('what a scan can navigate to', () => {
  it('names the subject so the app can open the booking', async () => {
    const r = await service().verifyByNumber('a'.repeat(64));

    expect(r.found).toBe(true);
    expect(r.subject).toEqual({
      type: 'reservation',
      id: '4d2fa9fb-e168-4f54-9030-2bd10b973a0c',
    });
  });

  it('accepts the fingerprint as it is typed off the page', async () => {
    const spaced = `${'a'.repeat(8)} ${'a'.repeat(8)} ${'a'.repeat(48)}`;
    const r = await service().verifyByNumber(spaced);

    expect(r.subject?.id).toBe('4d2fa9fb-e168-4f54-9030-2bd10b973a0c');
  });

  /*
    Numbers are sequential: RES-2026-000013, 000014, 000015. Returning
    subject ids against them would turn the public verification route
    into an index of every booking a business has taken.
  */
  it('discloses no subject against a document NUMBER', async () => {
    const r = await service().verifyByNumber('RES-2026-000014');

    expect(r.found).toBe(true);
    expect(r.subject).toBeUndefined();
    expect(r.content).toBeUndefined();
  });

  it('has nothing to point at when there is no such document', async () => {
    const r = await service({ byContentHash: null }).verifyByNumber('b'.repeat(64));

    expect(r.verdict).toBe('not_found');
    expect(r.subject).toBeUndefined();
  });

  /*
    A confirmation has no total, no currency and no lines — the invoice
    comparison is empty for it. What it does have is what is printed on
    it, and that is what the holder can check against the paper.
  */
  it('reads back the printed lines for a document with no total', async () => {
    const r = await service().verifyByNumber('a'.repeat(64));

    expect(r.content?.totalMinor).toBeNull();
    expect(r.content?.fields).toEqual(
      expect.arrayContaining([
        { label: 'Prestation', value: 'Freinage' },
        { label: 'Rendez-vous', value: '10/11/2026 23:12 - 00:12' },
      ]),
    );
    expect(r.message).toContain('Prestation Freinage');
    expect(r.message).toContain('CHECK THOSE AGAINST YOUR COPY');
  });
});
