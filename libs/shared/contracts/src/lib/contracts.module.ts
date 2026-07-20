import { Module } from '@nestjs/common';
import { VerticalRegistry } from './vertical-registry';

/**
 * Provides the VerticalRegistry. Verticals contribute providers under the
 * VERTICAL multi-token from their own modules; the core only ever sees the
 * registry.
 */
@Module({
  providers: [VerticalRegistry],
  exports: [VerticalRegistry],
})
export class ContractsModule {}
