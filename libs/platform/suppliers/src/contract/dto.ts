import type { AccountId, SupplierId } from '@justgo/kernel';

export interface SupplierDTO {
  id: SupplierId;
  ownerAccountId: AccountId;
  verticalKey: string;
  name: string;
  isOpen: boolean;
  isMultiBranch: boolean;
  city: string | null;
  country: string | null;
  address: string | null;
  /**
   * Fiscal identity. Null until the supplier completes its profile —
   * and `documents` REFUSES to invoice a seller missing any of these,
   * because an Algerian facture without them is not a tax document.
   */
  legalName: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  taxArticle: string | null;
  createdAt: string; // UTC ISO-8601
}

/** What a supplier may change about its own fiscal identity. */
export interface UpdateFiscalIdentityDTO {
  legalName?: string;
  address?: string;
  nif?: string;
  nis?: string;
  rc?: string;
  taxArticle?: string;
}

export interface RegisterSupplierDTO {
  verticalKey: string;
  name: string;
  city?: string;
  /** ISO-3166 alpha-2 */
  country?: string;
  lat?: number;
  lng?: number;
  profile?: Record<string, unknown>;
}
