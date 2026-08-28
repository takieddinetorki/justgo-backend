import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { SUPPLIERS_PORT } from './contract/suppliers.port';
import { SuppliersService, SUPPLIERS_REPOSITORY } from './application/suppliers.service';
import { PgSuppliersRepository } from './infra/pg-suppliers.repository';
import { SuppliersController } from './suppliers.controller';
import { SupplierCatalogController } from './supplier-catalog.controller';
import { PgCatalogRepository } from './infra/pg-catalog.repository';
import { CATALOG_REPOSITORY } from './application/catalog.tokens';

// VerticalRegistry arrives from the global ContractsModule.forRoot(...)
@Module({
  controllers: [SuppliersController, SupplierCatalogController],
  providers: [
    {
      provide: SUPPLIERS_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the suppliers module');
        return new PgSuppliersRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    {
      provide: CATALOG_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the suppliers module');
        return new PgCatalogRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: SUPPLIERS_PORT, useClass: SuppliersService },
    SuppliersService,
  ],
  exports: [SUPPLIERS_PORT],
})
export class SuppliersModule {}
