import { Module, type DynamicModule } from '@nestjs/common';
import { SUPPLIER_TARGETING_PORT } from '@justgo/contracts';
import { SuppliersModule } from '@justgo/suppliers';
import { SupplierTargetingAdapter } from './supplier-targeting.adapter';

/**
 * Binds the requests module's fan-out seam to the suppliers module
 * (§21.1), and makes it injectable from inside RequestsModule.
 *
 * WHY A MODULE, AND WHY GLOBAL. This adapter used to sit in AppModule's
 * own `providers` array, which does not work: Nest's injector is
 * one-directional. A module sees its own providers, the EXPORTS of
 * modules it imports, and global modules — nothing else. AppModule
 * imports RequestsModule, not the reverse, so `FanOutReactor` could
 * never see a provider declared in AppModule.
 *
 * The consequence was invisible and total. `SUPPLIER_TARGETING_PORT` was
 * injected `@Optional()`, so instead of failing at boot it resolved to
 * null, logged one warning, and dropped EVERY part request: 25 requests
 * submitted, zero quotes ever created, 21 of them silently expired. The
 * product's core loop had never run through the composed application.
 *
 * `ContractsModule` next door is `global: true` for the same reason, and
 * that contrast is the tell — `VerticalRegistry` injected fine in the
 * very same constructor where the targeting port came back null.
 *
 * This lives in the composition root on purpose: neither `requests` nor
 * `suppliers` may depend on the other (§4.7), so the app is the only
 * place allowed to join them. Swapping this for a network client is how
 * either module gets extracted later (§4.8).
 */
@Module({})
export class TargetingModule {
  static forRoot(): DynamicModule {
    return {
      module: TargetingModule,
      global: true,
      imports: [SuppliersModule],
      providers: [
        SupplierTargetingAdapter,
        { provide: SUPPLIER_TARGETING_PORT, useExisting: SupplierTargetingAdapter },
      ],
      exports: [SUPPLIER_TARGETING_PORT],
    };
  }
}
