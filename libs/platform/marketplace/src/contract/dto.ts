import type { AccountId, SupplierId } from '@justgo/kernel';
import type { MoneyDTO } from '@justgo/contracts';

export type ListingStatus = 'draft' | 'published' | 'pending_review' | 'sold' | 'withdrawn';

export interface ListingDTO {
  id: string;
  sellerAccountId: AccountId;
  supplierId: SupplierId | null;
  title: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  mileageKm: number | null;
  amount: MoneyDTO | null;
  description: string | null;
  photoUrls: string[];
  city: string | null;
  country: string | null;
  status: ListingStatus;
  createdAt: string;
}

export interface CreateListingDTO {
  title: string;
  brand?: string;
  model?: string;
  year?: number;
  mileageKm?: number;
  amount?: MoneyDTO;
  description?: string;
  photoUrls?: string[];
  city?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface ListingQuery {
  brand?: string;
  maxAmountMinor?: number;
  currency?: string;
  limit?: number;
}
