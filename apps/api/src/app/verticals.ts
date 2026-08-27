import type { SupplierVertical } from '@justgo/contracts';
import { PartStoreVertical } from '@justgo/vertical-part-store';
import { WholesalerVertical } from '@justgo/vertical-wholesaler';

/**
 * The app's verticals MANIFEST — the only place plug-ins are named (§9).
 * Adding a vertical = one import + one line here. Platform code stays
 * untouched; it discovers capabilities through the VerticalRegistry.
 */
export const ENABLED_VERTICALS: SupplierVertical[] = [
  new PartStoreVertical(),
  new WholesalerVertical(),
];
