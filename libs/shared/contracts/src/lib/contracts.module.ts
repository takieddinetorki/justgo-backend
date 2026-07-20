import { Module, type DynamicModule } from '@nestjs/common';
import { VerticalRegistry } from './vertical-registry';
import { VERTICAL, type SupplierVertical } from './verticals';

/**
 * Provides the VerticalRegistry, seeded with the app's enabled verticals.
 * Nest has no Angular-style multi-providers, so the composition root passes
 * the plug-in instances explicitly (its verticals manifest); platform code
 * still only ever sees the registry (§9).
 */
@Module({})
export class ContractsModule {
  static forRoot(verticals: SupplierVertical[]): DynamicModule {
    return {
      module: ContractsModule,
      global: true,
      providers: [{ provide: VERTICAL, useValue: verticals }, VerticalRegistry],
      exports: [VerticalRegistry],
    };
  }
}
