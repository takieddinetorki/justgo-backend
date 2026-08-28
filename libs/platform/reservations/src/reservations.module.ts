import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { CLOCK, SystemClock } from '@justgo/kernel';
import { RESERVATIONS_PORT } from './contract/reservations.port';
import { ReservationsService, RESERVATIONS_REPOSITORY } from './application/reservations.service';
import { PgReservationsRepository } from './infra/pg-reservations.repository';
import { ReservationsController } from './reservations.controller';
import { SupplierReservationsController } from './supplier-reservations.controller';

/** Owns the `reservations` schema (§8.3). Validates service types via the
 *  global SERVICE_CATALOG_PORT provided by the catalogue module. */
@Module({
  controllers: [ReservationsController, SupplierReservationsController],
  providers: [
    {
      provide: RESERVATIONS_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the reservations module');
        return new PgReservationsRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: RESERVATIONS_PORT, useClass: ReservationsService },
    ReservationsService,
  ],
  exports: [RESERVATIONS_PORT],
})
export class ReservationsModule {}
