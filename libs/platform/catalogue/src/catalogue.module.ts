import { Module } from '@nestjs/common';
import { CatalogueController } from './catalogue.controller';

/**
 * Exposes the catalogue browse API. CATALOGUE_PORT is provided globally by
 * the TecDoc integration module (stub in Phase 1, real adapter in Phase 2).
 */
@Module({
  controllers: [CatalogueController],
})
export class CatalogueModule {}
