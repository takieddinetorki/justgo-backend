import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

/**
 * An image in a private bucket, as (bucket, path) — never a URL.
 *
 * A stored URL is either a signed one that expires or a public one that
 * defeats the private-bucket rule every other image in this system follows
 * (§14). Upload through `POST /v1/media/uploads`, send back the `path`, and
 * read it as a short-lived signed URL.
 */
export interface MediaRefDTO {
  bucket: string;
  path: string;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** `HH:MM` on a 24-hour clock, in the business's own local time. */
export interface OpeningIntervalDTO {
  from: string;
  to: string;
}

/**
 * Opening hours per weekday. A missing day means closed; a day with two
 * intervals is a shop that shuts for lunch, which is the common case here
 * and the reason this is not seven pairs of columns.
 */
export type OpeningHoursDTO = Partial<Record<Weekday, OpeningIntervalDTO[]>>;

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
  description: string | null;
  phone: string | null;
  email: string | null;
  logo: MediaRefDTO | null;
  cover: MediaRefDTO | null;
  hours: OpeningHoursDTO | null;
  /** Average of published reviews, one decimal. Null until the first one. */
  rating: number | null;
  /** How many reviews that average is over — a 5.0 from one is not a 5.0 from four hundred. */
  ratingCount: number;
  /**
   * The badge. Set by JustGo through `PATCH /v1/supplier/{id}/verification`
   * and by nothing else: a badge the subject can award itself is worthless.
   */
  isVerified: boolean;
  verifiedAt: string | null;
  /**
   * The internal note on the verification decision. **Present only on an
   * `platform.admin` read** — it records which documents a business handed
   * over, which is nobody else's business.
   */
  verificationNote?: string | null;
  /** Set when the business has closed for good. Distinct from `isOpen`. */
  closedAt: string | null;
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
  updatedAt: string;
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

/**
 * What a supplier may change about the rest of its profile.
 *
 * `null` CLEARS a field and `undefined` leaves it alone — the two are
 * different answers and a PATCH that could not express the first would make
 * a description permanent once written.
 *
 * Deliberately absent: `verifiedAt`, `rating`, `ownerAccountId`,
 * `verticalKey`. The first two are awarded by other people, and the vertical
 * decides which matching rules and catalogue a business lives under — it is
 * a re-registration, not an edit.
 */
export interface UpdateSupplierProfileDTO {
  name?: string;
  description?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  country?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Open for business right now. Closing for good is DELETE, not this. */
  isOpen?: boolean;
  hours?: OpeningHoursDTO | null;
  logo?: MediaRefDTO | null;
  cover?: MediaRefDTO | null;
  /** Vertical plug-in data (§9). Replaced wholesale when present. */
  profile?: Record<string, unknown>;
}

export interface SetVerificationDTO {
  verified: boolean;
  /** Ops-only note: what was checked. Never returned on a public read. */
  note?: string;
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

// ── Branches ──────────────────────────────────────────────────────────

export interface BranchDTO {
  id: Uuid;
  supplierId: SupplierId;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  isOpen: boolean;
  hours: OpeningHoursDTO | null;
  lat: number | null;
  lng: number | null;
  closedAt: string | null;
  createdAt: string;
}

export interface CreateBranchDTO {
  name: string;
  address?: string;
  city?: string;
  country?: string;
  phone?: string;
  lat?: number;
  lng?: number;
  hours?: OpeningHoursDTO;
  isOpen?: boolean;
}

/** Same null-clears-it rule as the supplier profile patch. */
export interface UpdateBranchDTO {
  name?: string;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  phone?: string | null;
  lat?: number | null;
  lng?: number | null;
  hours?: OpeningHoursDTO | null;
  isOpen?: boolean;
}

// ── Reviews ───────────────────────────────────────────────────────────

export type ReviewStatus = 'published' | 'removed';
/** Which completed dealing earned the right to write this review. */
export type ReviewSource = 'order' | 'reservation';

export interface ReviewReplyDTO {
  reviewId: Uuid;
  supplierId: SupplierId;
  authorAccountId: AccountId;
  body: string;
  createdAt: string;
}

export interface ReviewDTO {
  id: Uuid;
  supplierId: SupplierId;
  authorAccountId: AccountId;
  /** 1–5, integer. */
  rating: number;
  body: string | null;
  status: ReviewStatus;
  /**
   * Every review on this platform is earned by a completed order or
   * reservation, so this is always set — it is carried so the app can say
   * which kind of dealing it came from.
   */
  source: ReviewSource;
  /** The business's single answer, if it has given one. */
  reply: ReviewReplyDTO | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReviewDTO {
  rating: number;
  body?: string;
}

export interface UpdateReviewDTO {
  rating?: number;
  body?: string | null;
}

export interface ReviewPage {
  items: ReviewDTO[];
  nextCursor: string | null;
  /** The supplier's average and count, so a page render needs one call. */
  summary: { rating: number | null; ratingCount: number };
}
