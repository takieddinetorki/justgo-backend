import { Module, type DynamicModule } from '@nestjs/common';
import { Pool } from 'pg';
import { SERVICE_CATALOG_PORT } from '@justgo/contracts';
import { CatalogueController } from './catalogue.controller';
import { ServiceTypesController } from './service-types.controller';
import { PgServiceCatalogRepository } from './infra/pg-service-catalog.repository';

/**
 * Catalogue browse API. CATALOGUE_PORT (TecDoc parts) is provided globally by
 * the TecDoc module. This module owns the `catalogue` schema — service types
 * + assembly-group taxonomy — and provides SERVICE_CATALOG_PORT globally so
 * reservations can validate service types without cross-schema reads (§17.4).
 */
@Module({})
export class CatalogueModule {
  static forRoot(): DynamicModule {
    return {
      module: CatalogueModule,
      global: true,
      controllers: [CatalogueController, ServiceTypesController],
      providers: [
        {
          provide: SERVICE_CATALOG_PORT,
          useFactory: () => {
            const url = process.env['DATABASE_URL'];
            if (!url) throw new Error('DATABASE_URL is required for the catalogue module');
            return new PgServiceCatalogRepository(new Pool({ connectionString: url, max: 3 }));
          },
        },
      ],
      exports: [SERVICE_CATALOG_PORT],
    };
  }
}
