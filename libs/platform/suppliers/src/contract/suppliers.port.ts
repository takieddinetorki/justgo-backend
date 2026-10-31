import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';
import type {
  BranchDTO,
  CreateBranchDTO,
  CreateReviewDTO,
  RegisterSupplierDTO,
  ReviewDTO,
  ReviewPage,
  SetVerificationDTO,
  SupplierDTO,
  UpdateBranchDTO,
  UpdateFiscalIdentityDTO,
  UpdateReviewDTO,
  UpdateSupplierProfileDTO,
} from './dto';

/**
 * Public port of the suppliers context (§6.1). The Quote Engine targets
 * suppliers exclusively through eligibleForPartRequest — matching rules
 * behind this seam are an Open Question (§21.1); today: open suppliers of
 * the given verticals, optionally filtering on catalogue category.
 */
export interface SuppliersPort {
  register(ownerAccountId: AccountId, input: RegisterSupplierDTO): Promise<SupplierDTO>;
  getById(id: SupplierId): Promise<SupplierDTO | null>;
  getByOwner(ownerAccountId: AccountId): Promise<SupplierDTO | null>;
  /** The seller block an invoice needs. Owner-gated at the controller. */
  updateFiscalIdentity(id: SupplierId, patch: UpdateFiscalIdentityDTO): Promise<SupplierDTO>;
  /** Everything else a business may change about itself. Owner-gated. */
  updateProfile(id: SupplierId, patch: UpdateSupplierProfileDTO): Promise<SupplierDTO>;
  /**
   * Close the business for good. A soft close, never a row delete: orders,
   * invoices, reservations and reviews all reference this id, and a gapless
   * fiscal series may not point at a seller that vanished.
   */
  close(id: SupplierId): Promise<SupplierDTO>;
  /**
   * Award or withdraw the verified badge. `platform.admin` only — there is
   * deliberately no path by which an owner's own token reaches this.
   */
  setVerification(
    id: SupplierId,
    input: SetVerificationDTO,
    decidedByAccountId: AccountId,
  ): Promise<SupplierDTO>;
  eligibleForPartRequest(verticalKeys: string[], categoryKey: string | null): Promise<SupplierId[]>;
}

export const SUPPLIERS_PORT = Symbol('SUPPLIERS_PORT');

/** Branches of a multi-site business. Every method is owner-scoped. */
export interface BranchesPort {
  list(supplierId: SupplierId, opts?: { includeClosed?: boolean }): Promise<BranchDTO[]>;
  create(supplierId: SupplierId, input: CreateBranchDTO): Promise<BranchDTO>;
  update(supplierId: SupplierId, branchId: Uuid, input: UpdateBranchDTO): Promise<BranchDTO>;
  /** Soft close — a session token may already carry this branch id. */
  close(supplierId: SupplierId, branchId: Uuid): Promise<BranchDTO>;
}

export const BRANCHES_PORT = Symbol('BRANCHES_PORT');

/**
 * Reviews of a business.
 *
 * Writing one requires a COMPLETED order or reservation with that supplier.
 * The evidence lives in other modules' schemas, so it arrives as events and
 * is kept here as a read model — `mayReview` answers from that, never by
 * reaching into `orders` (§17.4).
 */
export interface ReviewsPort {
  list(
    supplierId: SupplierId,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ReviewPage>;
  /** The caller's own review of this business, if they have written one. */
  mine(supplierId: SupplierId, accountId: AccountId): Promise<ReviewDTO | null>;
  /** Whether this account has a completed dealing that entitles them to review. */
  mayReview(supplierId: SupplierId, accountId: AccountId): Promise<boolean>;

  write(supplierId: SupplierId, authorAccountId: AccountId, input: CreateReviewDTO): Promise<ReviewDTO>;
  edit(reviewId: Uuid, authorAccountId: AccountId, input: UpdateReviewDTO): Promise<ReviewDTO>;
  /** The author retracts their own. Frees them to write a new one later. */
  retract(reviewId: Uuid, authorAccountId: AccountId): Promise<ReviewDTO>;
  /** Administrative takedown — `platform.admin`, any review, with a reason. */
  takedown(reviewId: Uuid, reason: string): Promise<ReviewDTO>;

  /** The business's single answer. Replaces an earlier one. */
  reply(reviewId: Uuid, supplierId: SupplierId, authorAccountId: AccountId, body: string): Promise<ReviewDTO>;
  /** Which business a review is about — a reply has to be owner-scoped to it. */
  supplierOf(reviewId: Uuid): Promise<SupplierId | null>;

  /**
   * Record that an account completed a dealing with a supplier, which is
   * what entitles them to review it. Called by the reactor, never by a
   * controller.
   */
  recordEligibility(input: {
    accountId: AccountId;
    supplierId: SupplierId;
    source: 'order' | 'reservation';
    sourceId: Uuid;
  }): Promise<void>;
}

export const REVIEWS_PORT = Symbol('REVIEWS_PORT');
