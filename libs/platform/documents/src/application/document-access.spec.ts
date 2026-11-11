import { DocumentsService } from './documents.service';
import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

/**
 * Who may retrieve a facture.
 *
 * A facture has TWO parties and both are entitled to it. The client it
 * was issued to — never in doubt. And the business that issued it, which
 * was refused outright: `listForAccount` filters on
 * `issued_to_account_id` and `downloadUrl` compared the caller against
 * the recipient and nothing else.
 *
 * So the document that carries a business's NIF, NIS, RC and article
 * d'imposition was invisible to that business. `supplier_id` was written
 * on every row from migration 0020 onwards and read by nothing. That is
 * not a missing convenience: the set of factures a business has issued
 * is its sales ledger, and it is required to keep it.
 *
 * Everyone else still gets 404, not 403 — a document id should not be
 * confirmable by someone with no claim to it.
 */

const CLIENT = '11111111-1111-4111-8111-111111111111' as AccountId;
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222' as AccountId;
const ISSUER = '33333333-3333-4333-8333-333333333333' as SupplierId;
const OTHER_SUPPLIER = '44444444-4444-4444-8444-444444444444' as SupplierId;
const DOC_ID = '55555555-5555-4555-8555-555555555555' as Uuid;

const FACTURE = {
  id: DOC_ID,
  type: 'invoice',
  number: 'FA-2026-000018',
  issuedToAccountId: CLIENT,
  supplierId: ISSUER,
  bucket: 'documents',
  path: 'fa/FA-2026-000018.pdf',
};

function service(doc: Record<string, unknown> | null = FACTURE) {
  const signed: Array<{ bucket: string; path: string }> = [];
  const repo = {
    byId: jest.fn(async () => doc),
    listForAccount: jest.fn(async () => []),
    listForSupplier: jest.fn(async () => []),
  };
  const media = {
    createSignedDownloadUrl: jest.fn(async (input: { bucket: string; path: string }) => {
      signed.push(input);
      return `https://signed.test/${input.path}`;
    }),
  };
  const svc = new DocumentsService(repo as never, { verify: jest.fn() } as never, media as never, {
    bucket: 'documents',
    verifyBaseUrl: 'http://api.test/v1/documents/verify',
  });
  return { svc, repo, signed };
}

describe('who may download a facture', () => {
  it('the client it was issued to', async () => {
    const { svc } = service();
    await expect(svc.downloadUrl({ accountId: CLIENT }, DOC_ID)).resolves.toContain(
      'FA-2026-000018.pdf',
    );
  });

  /*
    THE CASE THAT WAS MISSING. A supplier-scoped token whose supplier is
    the issuer. Its own account id has nothing to do with the document.
  */
  it('and the business that issued it', async () => {
    const { svc } = service();
    await expect(
      svc.downloadUrl({ accountId: OTHER_ACCOUNT, supplierId: ISSUER }, DOC_ID),
    ).resolves.toContain('FA-2026-000018.pdf');
  });

  it('nobody else, and they are told 404 rather than 403', async () => {
    const { svc } = service();
    await expect(svc.downloadUrl({ accountId: OTHER_ACCOUNT }, DOC_ID)).rejects.toThrow(
      /not found/i,
    );
  });

  /*
    A supplier-scoped token is not a key to every document. Another
    business holding one must not reach this facture.
  */
  it('not another business, even with a supplier-scoped token', async () => {
    const { svc } = service();
    await expect(
      svc.downloadUrl({ accountId: OTHER_ACCOUNT, supplierId: OTHER_SUPPLIER }, DOC_ID),
    ).rejects.toThrow(/not found/i);
  });

  /*
    A confirmation carries no supplier_id. A caller presenting *some*
    supplier scope must not match a null one — `undefined === null` is
    false in JS, but only because both sides are checked explicitly, and
    this is the test that keeps them checked.
  */
  it('and never matches a document with no issuer on it', async () => {
    const { svc } = service({ ...FACTURE, supplierId: null });
    await expect(
      svc.downloadUrl({ accountId: OTHER_ACCOUNT, supplierId: ISSUER }, DOC_ID),
    ).rejects.toThrow(/not found/i);
  });

  it('a document that does not exist is 404 either way', async () => {
    const { svc } = service(null);
    await expect(svc.downloadUrl({ accountId: CLIENT, supplierId: ISSUER }, DOC_ID)).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('listing them', () => {
  it('asks by recipient for the client, by issuer for the business', async () => {
    const { svc, repo } = service();
    await svc.listForAccount(CLIENT, 20, 'invoice');
    await svc.listForSupplier(ISSUER, 20, 'invoice');
    expect(repo.listForAccount).toHaveBeenCalledWith(CLIENT, 20, 'invoice');
    expect(repo.listForSupplier).toHaveBeenCalledWith(ISSUER, 20, 'invoice');
  });

  /*
    The cap is the service's job, not the caller's. A ledger screen
    asking for 10 000 rows should get 100, not 10 000.
  */
  it('caps the page at 100 however much is asked for', async () => {
    const { svc, repo } = service();
    await svc.listForAccount(CLIENT, 10_000);
    await svc.listForSupplier(ISSUER, 10_000);
    expect(repo.listForAccount).toHaveBeenCalledWith(CLIENT, 100, undefined);
    expect(repo.listForSupplier).toHaveBeenCalledWith(ISSUER, 100, undefined);
  });
});
