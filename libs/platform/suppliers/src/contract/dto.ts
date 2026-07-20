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
  createdAt: string; // UTC ISO-8601
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
