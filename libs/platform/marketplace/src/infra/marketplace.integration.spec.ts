/** Used-car marketplace against live Postgres. Skipped without DATABASE_URL. */
import { Pool } from 'pg';
import { newId, type AccountId } from '@justgo/kernel';
import { PgMarketplaceRepository } from './pg-marketplace.repository';
import { MarketplaceService } from '../application/marketplace.service';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

describePg('marketplace', () => {
  let pool: Pool;
  let service: MarketplaceService;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new MarketplaceService(new PgMarketplaceRepository(pool));
  });
  afterAll(async () => {
    await pool.end();
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
