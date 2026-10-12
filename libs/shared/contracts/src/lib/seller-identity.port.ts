/**
 * The seller block a *facture* must carry, fetched across a module
 * boundary.
 *
 * A seam, exactly like `SupplierTargetingPort` (§21.1): `documents` needs
 * the supplier's fiscal identifiers but must not depend on the suppliers
 * module, and suppliers must not know documents exists. The composition
 * root joins them, which is also what keeps either extractable (§4.8).
 *
 * Every field below is legally required on an Algerian invoice. They are
 * nullable here because a supplier may not have filled them in yet —
 * `documents` refuses to issue when any is missing, rather than emitting
 * an official-looking document that is not a tax document.
 */
export interface SellerIdentity {
  legalName: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  taxArticle: string | null;
}

export interface SellerIdentityPort {
  sellerFor(supplierId: string): Promise<SellerIdentity | null>;
}

export const SELLER_IDENTITY_PORT = Symbol('SELLER_IDENTITY_PORT');
