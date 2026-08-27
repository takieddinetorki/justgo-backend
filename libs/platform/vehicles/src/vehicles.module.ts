import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { VEHICLES_PORT } from './contract/vehicles.port';
import { VehiclesService, VEHICLES_REPOSITORY } from './application/vehicles.service';
import { PgVehiclesRepository } from './infra/pg-vehicles.repository';
import { VehiclesController } from './vehicles.controller';

/** Owns the `vehicles` schema; resolves KType via CATALOGUE_PORT (global). */
@Module({
  controllers: [VehiclesController],
  providers: [
    {
      provide: VEHICLES_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the vehicles module');
        return new PgVehiclesRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: VEHICLES_PORT, useClass: VehiclesService },
    VehiclesService,
  ],
  exports: [VEHICLES_PORT],
})
export class VehiclesModule {}
