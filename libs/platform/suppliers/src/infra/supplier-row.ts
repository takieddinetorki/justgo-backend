import { asId, type AccountId, type SupplierId } from '@justgo/kernel';
import type { MediaRefDTO, OpeningHoursDTO, SupplierDTO } from '../contract/dto';
import type { SupplierUpdatedV1 } from '../contract/events';

/**
 * One shape for a supplier row, shared by the two repositories that read it.
 *
 * `reviews` recomputes the rating and must then announce the new row to the
 * discovery read model, exactly as a profile edit does. Duplicating the
 * column list and the mapper is how the two would drift — one of them
 * forgetting `is_verified` and quietly un-verifying a business every time
 * somebody left a review.
 */
export interface SupplierRow {
  id: string;
  owner_account_id: string;
  vertical_key: string;
  name: string;
  is_open: boolean;
  is_multi_branch: boolean;
  city: string | null;
  country: string | null;
  address: string | null;
  description: string | null;
  phone: string | null;
  email: string | null;
  logo_bucket: string | null;
  logo_path: string | null;
  cover_bucket: string | null;
  cover_path: string | null;
  hours: OpeningHoursDTO | null;
  rating: string | null;
  rating_count: number;
  verified_at: Date | null;
  verified_by_account_id: string | null;
  verification_note: string | null;
  closed_at: Date | null;
  legal_name: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  tax_article: string | null;
  created_at: Date;
  updated_at: Date;
  lat: number | null;
  lng: number | null;
}

/**
 * Every column the mapper needs, as a `select` list AND as a `returning`
 * list — Postgres accepts expressions in both, so an update can hand back a
 * complete row without a second round trip.
 */
export const SUPPLIER_COLS = `id, owner_account_id, vertical_key, name, is_open,
  is_multi_branch, city, country, address, description, phone, email,
  logo_bucket, logo_path, cover_bucket, cover_path, hours,
  rating, rating_count, verified_at, verified_by_account_id, verification_note,
  closed_at, legal_name, nif, nis, tax_article, rc, created_at, updated_at,
  ST_Y(geo::geometry) as lat, ST_X(geo::geometry) as lng`;

function mediaRef(bucket: string | null, path: string | null): MediaRefDTO | null {
  return bucket && path ? { bucket, path } : null;
}

/**
 * `includeNote` defaults to FALSE, and that default is the point.
 *
 * The verification note records which documents a business handed over. It
 * is for ops, and the one way it leaks is a mapper that returns it unless
 * told not to — so the admin read is the one that has to ask.
 */
export function toSupplierDTO(row: SupplierRow, includeNote = false): SupplierDTO {
  return {
    id: asId<SupplierId>(row.id),
    ownerAccountId: asId<AccountId>(row.owner_account_id),
    verticalKey: row.vertical_key,
    name: row.name,
    isOpen: row.is_open,
    isMultiBranch: row.is_multi_branch,
    city: row.city,
    country: row.country,
    address: row.address,
    description: row.description,
    phone: row.phone,
    email: row.email,
    logo: mediaRef(row.logo_bucket, row.logo_path),
    cover: mediaRef(row.cover_bucket, row.cover_path),
    hours: row.hours,
    // numeric arrives from pg as a string; Number(null) is 0, which would
    // read as "rated zero" rather than "never rated".
    rating: row.rating === null ? null : Number(row.rating),
    ratingCount: Number(row.rating_count ?? 0),
    isVerified: row.verified_at !== null,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    ...(includeNote ? { verificationNote: row.verification_note } : {}),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    legalName: row.legal_name,
    nif: row.nif,
    nis: row.nis,
    rc: row.rc,
    taxArticle: row.tax_article,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The `suppliers.SupplierUpdated` payload for a row.
 *
 * `categoryKeys` is omitted unless the caller knows it: it comes from the
 * vertical registry, which a rating recomputation has no reason to consult,
 * and the read model preserves what it already holds when the field is
 * absent. Sending `[]` instead would erase the category coverage of every
 * supplier anyone ever reviewed.
 */
export function toUpdatedEvent(row: SupplierRow, categoryKeys?: string[]): SupplierUpdatedV1 {
  return {
    supplierId: row.id,
    verticalKey: row.vertical_key,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    ...(categoryKeys ? { categoryKeys } : {}),
    city: row.city,
    country: row.country,
    isOpen: row.is_open,
    isVerified: row.verified_at !== null,
    rating: row.rating === null ? null : Number(row.rating),
    ratingCount: Number(row.rating_count ?? 0),
  };
}
