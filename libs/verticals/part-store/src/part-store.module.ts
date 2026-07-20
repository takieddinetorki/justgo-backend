import { Module } from '@nestjs/common';
import { PartStoreVertical } from './part-store.vertical';

/**
 * The vertical's own Nest module. The composition root passes
 * PartStoreVertical to ContractsModule.forRoot() via its verticals
 * manifest — no platform file names this vertical (§9).
 */
@Module({
  providers: [PartStoreVertical],
  exports: [PartStoreVertical],
})
export class PartStoreModule {}
