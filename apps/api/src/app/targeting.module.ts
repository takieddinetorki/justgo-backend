import { Module, type DynamicModule } from '@nestjs/common';
import {
  MILEAGE_COMPLIANCE_PORT,
  PARTY_DIRECTORY_PORT,
  SELLER_IDENTITY_PORT,
  SUPPLIER_TARGETING_PORT,
  VEHICLE_DIRECTORY_PORT,
} from '@justgo/contracts';
import { IdentityModule } from '@justgo/identity';
import { SuppliersModule } from '@justgo/suppliers';
import { VehiclesModule } from '@justgo/vehicles';
import { SupplierTargetingAdapter } from './supplier-targeting.adapter';
import { SellerIdentityAdapter } from './seller-identity.adapter';
import { PartyDirectoryAdapter } from './party-directory.adapter';
import { VehicleDirectoryAdapter } from './vehicle-directory.adapter';
import { MileageComplianceAdapter } from './mileage-compliance.adapter';

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
 *
 * It now carries every such seam, not just targeting — `documents` needs
 * the seller's fiscal identity from `suppliers`, and the booking screens
 * need a customer's name from `identity` and a car from `vehicles`, on
 * exactly the same terms. One global module keeps them together rather
 * than scattering a module per join.
 */
@Module({})
export class TargetingModule {
  static forRoot(): DynamicModule {
    return {
      module: TargetingModule,
      global: true,
      imports: [SuppliersModule, IdentityModule, VehiclesModule],
      providers: [
        SupplierTargetingAdapter,
        { provide: SUPPLIER_TARGETING_PORT, useExisting: SupplierTargetingAdapter },
        SellerIdentityAdapter,
        { provide: SELLER_IDENTITY_PORT, useExisting: SellerIdentityAdapter },
        PartyDirectoryAdapter,
        { provide: PARTY_DIRECTORY_PORT, useExisting: PartyDirectoryAdapter },
        VehicleDirectoryAdapter,
        { provide: VEHICLE_DIRECTORY_PORT, useExisting: VehicleDirectoryAdapter },
        MileageComplianceAdapter,
        { provide: MILEAGE_COMPLIANCE_PORT, useExisting: MileageComplianceAdapter },
      ],
      exports: [
        SUPPLIER_TARGETING_PORT,
        SELLER_IDENTITY_PORT,
        PARTY_DIRECTORY_PORT,
        VEHICLE_DIRECTORY_PORT,
        MILEAGE_COMPLIANCE_PORT,
      ],
    };
  }
}
