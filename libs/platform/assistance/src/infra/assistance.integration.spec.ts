/** Roadside assistance flow against live Postgres/PostGIS. Skipped without DATABASE_URL. */
import { Pool } from 'pg';
import { newId, type AccountId, type SupplierId } from '@justgo/kernel';
import { PgAssistanceRepository } from './pg-assistance.repository';
import { AssistanceService } from '../application/assistance.service';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

describePg('assistance', () => {
  let pool: Pool;
  let service: AssistanceService;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new AssistanceService(new PgAssistanceRepository(pool));
  });
  afterAll(async () => {
    await pool.end();
  });

  it('creates a request, round-trips the pickup location, and emits AssistanceRequested', async () => {
    const client = newId<AccountId>();
    const req = await service.request(client, {
      serviceType: 'tow',
      lat: 48.8566,
      lng: 2.3522,
      description: 'Flat battery',
    });
    expect(req.status).toBe('requested');
    expect(req.lat).toBeCloseTo(48.8566, 3);
    expect(req.lng).toBeCloseTo(2.3522, 3);

    const events = await pool.query(`select type from assistance.outbox where aggregate_id = $1`, [req.id]);
    expect(events.rows.map((r) => r.type)).toContain('assistance.AssistanceRequested');
  });

  it('a supplier accepts then advances requested -> dispatched -> en_route -> completed', async () => {
    const client = newId<AccountId>();
    const supplier = newId<SupplierId>();
    const req = await service.request(client, { serviceType: 'breakdown', lat: 40.4168, lng: -3.7038 });

    const dispatched = await service.accept(supplier, req.id);
    expect(dispatched.status).toBe('dispatched');
    expect(dispatched.assignedSupplierId).toBe(supplier);

    expect((await service.advance(supplier, req.id, 'en_route')).status).toBe('en_route');
    expect((await service.advance(supplier, req.id, 'completed')).status).toBe('completed');
  });

  it('stops a different supplier from advancing an assigned request', async () => {
    const req = await service.request(newId<AccountId>(), { serviceType: 'lockout', lat: 41.3874, lng: 2.1686 });
    const owner = newId<SupplierId>();
    await service.accept(owner, req.id);
    await expect(service.advance(newId<SupplierId>(), req.id, 'en_route')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('lets the client cancel while open and hides it from other clients', async () => {
    const client = newId<AccountId>();
    const req = await service.request(client, { serviceType: 'fuel', lat: 48.85, lng: 2.35 });
    const cancelled = await service.cancel(client, req.id);
    expect(cancelled.status).toBe('cancelled');
    await expect(service.cancel(newId<AccountId>(), req.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
