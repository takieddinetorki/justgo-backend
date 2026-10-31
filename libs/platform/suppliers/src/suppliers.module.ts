import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { BRANCHES_PORT, REVIEWS_PORT, SUPPLIERS_PORT } from './contract/suppliers.port';
import { SuppliersService, SUPPLIERS_REPOSITORY } from './application/suppliers.service';
import { BranchesService, BRANCHES_REPOSITORY } from './application/branches.service';
import { ReviewsService, REVIEWS_REPOSITORY } from './application/reviews.service';
import { ReviewEligibilityReactor } from './application/review-eligibility.reactor';
import { PgSuppliersRepository } from './infra/pg-suppliers.repository';
import { PgBranchesRepository } from './infra/pg-branches.repository';
import { PgReviewsRepository } from './infra/pg-reviews.repository';
import { SuppliersController } from './suppliers.controller';
import { SupplierBranchesController } from './supplier-branches.controller';
import { SupplierReviewsController } from './supplier-reviews.controller';
import { SupplierCatalogController } from './supplier-catalog.controller';
import { PgCatalogRepository } from './infra/pg-catalog.repository';
import { CATALOG_REPOSITORY } from './application/catalog.tokens';

function pool(): Pool {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required for the suppliers module');
  return new Pool({ connectionString: url, max: 5 });
}

// VerticalRegistry arrives from the global ContractsModule.forRoot(...)
@Module({
  controllers: [
    /*
      SuppliersController FIRST. It owns the literal routes under
      `/v1/supplier` (`profile`, `fiscal`) as well as `:id/verification`;
      registering a param route ahead of a literal one is how
      `/v1/supplier/profile` would start resolving as a supplier id.
    */
    SuppliersController,
    SupplierBranchesController,
    SupplierReviewsController,
    SupplierCatalogController,
  ],
  providers: [
    { provide: SUPPLIERS_REPOSITORY, useFactory: () => new PgSuppliersRepository(pool()) },
    { provide: BRANCHES_REPOSITORY, useFactory: () => new PgBranchesRepository(pool()) },
    { provide: REVIEWS_REPOSITORY, useFactory: () => new PgReviewsRepository(pool()) },
    { provide: CATALOG_REPOSITORY, useFactory: () => new PgCatalogRepository(pool()) },
    { provide: SUPPLIERS_PORT, useClass: SuppliersService },
    { provide: BRANCHES_PORT, useClass: BranchesService },
    { provide: REVIEWS_PORT, useClass: ReviewsService },
    SuppliersService,
    BranchesService,
    ReviewsService,
    ReviewEligibilityReactor,
  ],
  exports: [SUPPLIERS_PORT, BRANCHES_PORT, REVIEWS_PORT],
})
export class SuppliersModule {}
