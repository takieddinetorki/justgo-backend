import type { SupplierId } from '@justgo/kernel';
import type { MoneyDTO } from '@justgo/contracts';

export interface ProductDTO {
  id: string;
  supplierId: SupplierId;
  tecdocArticleId: number | null;
  name: string;
  reference: string | null;
  categoryKey: string | null;
  amount: MoneyDTO | null;
  quantity: number;
  isDeal: boolean;
  createdAt: string;
}

export interface CreateProductDTO {
  name: string;
  tecdocArticleId?: number;
  reference?: string;
  categoryKey?: string;
  amount?: MoneyDTO;
  quantity?: number;
  isDeal?: boolean;
}

export interface UpdateProductDTO {
  name?: string;
  reference?: string;
  categoryKey?: string;
  amount?: MoneyDTO;
  quantity?: number;
  isDeal?: boolean;
}

export interface ServiceOfferDTO {
  id: string;
  supplierId: SupplierId;
  serviceTypeKey: string;
  name: string;
  description: string | null;
  amount: MoneyDTO | null;
  durationMins: number | null;
  active: boolean;
}

export interface CreateOfferDTO {
  serviceTypeKey: string;
  name: string;
  description?: string;
  amount?: MoneyDTO;
  durationMins?: number;
}
