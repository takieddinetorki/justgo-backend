import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { MARKETPLACE_PORT } from './contract/marketplace.port';
import { MarketplaceService, MARKETPLACE_REPOSITORY } from './application/marketplace.service';
import { PgMarketplaceRepository } from './infra/pg-marketplace.repository';
import { MarketplaceController } from './marketplace.controller';

/** Owns the `marketplace` schema — used-car listings + buyer contact (§7). */
@Module({
  controllers: [MarketplaceController],
  providers: [
    {
      provide: MARKETPLACE_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the marketplace module');
        return new PgMarketplaceRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: MARKETPLACE_PORT, useClass: MarketplaceService },
    MarketplaceService,
  ],
  exports: [MARKETPLACE_PORT],
})
export class MarketplaceModule {}
