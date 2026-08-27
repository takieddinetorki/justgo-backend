import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { DISCOVERY_PORT } from './contract/discovery.port';
import { DiscoveryService, DISCOVERY_REPOSITORY } from './application/discovery.service';
import { SupplierIndexReactor } from './application/supplier-index.reactor';
import { PgDiscoveryRepository } from './infra/pg-discovery.repository';
import { DiscoveryController } from './discovery.controller';

/** Owns the `discovery` schema; a read model fed by suppliers events (§6.1). */
@Module({
  controllers: [DiscoveryController],
  providers: [
    {
      provide: DISCOVERY_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the discovery module');
        return new PgDiscoveryRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: DISCOVERY_PORT, useClass: DiscoveryService },
    DiscoveryService,
    SupplierIndexReactor,
  ],
  exports: [DISCOVERY_PORT],
})
export class DiscoveryModule {}
