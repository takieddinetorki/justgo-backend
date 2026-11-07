/** Used-car marketplace against live Postgres. Skipped without DATABASE_URL. */
import { Pool } from 'pg';
import { newId, type AccountId } from '@justgo/kernel';
import { PgMarketplaceRepository } from './pg-marketplace.repository';
import type { MediaPort } from '@justgo/media';
import { MarketplaceService } from '../application/marketplace.service';

/*
  Signs predictably instead of calling Storage. The point under test is
  that a stored (bucket, path) comes back as something in `photoUrls` at
  all — that is the defect this covers, and it does not need a real
  bucket to catch it.
*/
const media = {
  createSignedDownloadUrls: async (input: { bucket: string; paths: string[] }) =>
    new Map(input.paths.map((path) => [path, `https://signed.test/${input.bucket}/${path}`])),
} as unknown as MediaPort;

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

describePg('marketplace', () => {
  let pool: Pool;
  let service: MarketplaceService;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new MarketplaceService(new PgMarketplaceRepository(pool), media);
  });
  afterAll(async () => {
    await pool.end();
  });

  /*
    The sell-a-car screen uploaded photos into a private bucket and then
    had nowhere to put them: `photoUrls` demanded an absolute URL, so
    every listing on the dev box was stored with `photo_urls = '{}'`
    while objects piled up in `vehicle-photos`.
  */
  it('stores photo refs and returns them as URLs that load', async () => {
    const seller = newId<AccountId>();
    const listing = await service.publish(seller, {
      title: 'Peugeot 208 2019',
      photos: [{ bucket: 'vehicle-photos', path: `${seller}/1_front.jpg` }],
    });
    expect(listing.photos).toHaveLength(1);
    expect(listing.photoUrls).toEqual([`https://signed.test/vehicle-photos/${seller}/1_front.jpg`]);

    // and again on the read path, not only on the write that returned it
    const fetched = await service.get(listing.id);
    expect(fetched.photoUrls[0]).toContain('signed.test');
  });

  it('refuses a photo uploaded by somebody else', async () => {
    const seller = newId<AccountId>();
    const someoneElse = newId<AccountId>();
    await expect(
      service.publish(seller, {
        title: 'Not my car',
        photos: [{ bucket: 'vehicle-photos', path: `${someoneElse}/1_front.jpg` }],
      }),
    ).rejects.toThrow(/your own uploads/i);
  });

  it('publishes a listing that then appears in browse and by id', async () => {
    const seller = newId<AccountId>();
    const listing = await service.publish(seller, {
      title: 'BMW 320d 2016',
      brand: 'BMW',
      model: '320d',
      year: 2016,
      mileageKm: 120000,
      amount: { amountMinor: 1500000, currency: 'EUR' },
      city: 'Paris',
      country: 'FR',
    });
    expect(listing.status).toBe('published');

    const byId = await service.get(listing.id);
    expect(byId.title).toBe('BMW 320d 2016');

    const browse = await service.browse({ brand: 'BMW', limit: 100 });
    expect(browse.map((l) => l.id)).toContain(listing.id);
  });

  it('records a buyer contact once and emits BuyerContacted', async () => {
    const seller = newId<AccountId>();
    const buyer = newId<AccountId>();
    const listing = await service.publish(seller, { title: 'Clio for sale' });

    await service.contact(buyer, listing.id, 'Still available?');
    await service.contact(buyer, listing.id, 'Ping'); // idempotent per (listing, buyer)

    const contacts = await pool.query(`select count(*)::int n from marketplace.listing_contacts where listing_id = $1`, [listing.id]);
    expect(contacts.rows[0].n).toBe(1);
    const events = await pool.query(`select type from marketplace.outbox where aggregate_id = $1`, [listing.id]);
    expect(events.rows.map((r) => r.type).sort()).toEqual(['marketplace.BuyerContacted', 'marketplace.ListingPublished']);
  });

  it('stops a seller contacting their own listing', async () => {
    const seller = newId<AccountId>();
    const listing = await service.publish(seller, { title: 'Mine' });
    await expect(service.contact(seller, listing.id)).rejects.toMatchObject({ code: 'CANNOT_CONTACT_OWN_LISTING' });
  });

  it('withdraws a listing so it leaves browse', async () => {
    const seller = newId<AccountId>();
    const listing = await service.publish(seller, { title: 'Golf', brand: 'VW' });
    await service.withdraw(seller, listing.id);
    const browse = await service.browse({ limit: 200 });
    expect(browse.map((l) => l.id)).not.toContain(listing.id);
  });
});
