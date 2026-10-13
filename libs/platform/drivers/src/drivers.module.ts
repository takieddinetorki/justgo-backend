import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { DRIVERS_PORT } from './contract/drivers.port';
import { DriversService, DRIVERS_REPOSITORY } from './application/drivers.service';
import { PgDriversRepository } from './infra/pg-drivers.repository';
import { DriversController } from './drivers.controller';

/** Owns the `drivers` schema. Extract-ready: its own Pool (§4.8). */
@Module({
  controllers: [DriversController],
  providers: [
    {
      provide: DRIVERS_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the drivers module');
        return new PgDriversRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: DRIVERS_PORT, useClass: DriversService },
    DriversService,
  ],
  exports: [DRIVERS_PORT],
})
export class DriversModule {}
