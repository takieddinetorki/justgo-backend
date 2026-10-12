import { Inject, Injectable } from '@nestjs/common';
import type { SellerIdentity, SellerIdentityPort } from '@justgo/contracts';
import { SUPPLIERS_PORT, type SuppliersPort } from '@justgo/suppliers';

/**
 * Composition-root adapter binding the invoice seller block to the
 * suppliers module (§21.1). Neither `documents` nor `suppliers` depends
 * on the other; the app joins them through the shared contract, so
 * either can be extracted behind a network client later (§4.8).
 */
@Injectable()
export class SellerIdentityAdapter implements SellerIdentityPort {
  constructor(@Inject(SUPPLIERS_PORT) private readonly suppliers: SuppliersPort) {}

  async sellerFor(supplierId: string): Promise<SellerIdentity | null> {
    const s = await this.suppliers.getById(supplierId as never);
    if (!s) return null;
    return {
      // Fall back to the trading name so the invoice is not nameless; the
      // other identifiers have no sensible fallback and stay null, which
      // is what makes documents refuse to issue.
      legalName: s.legalName ?? s.name,
      address: s.address,
      city: s.city,
      country: s.country,
      nif: s.nif,
      nis: s.nis,
      rc: s.rc,
      taxArticle: s.taxArticle,
    };
  }
}
