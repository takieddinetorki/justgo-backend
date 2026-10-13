import type { AccountId, Uuid } from '@justgo/kernel';
import type {
  ApplyAsDriverDTO,
  AttachDocumentDTO,
  DriverDTO,
  DriverStatus,
  SetAvailabilityDTO,
  UpdateDriverDTO,
} from './dto';

/** Public port of the drivers context (§6.1). */
export interface DriversPort {
  /** Create the profile, or return the one this account already has. */
  apply(accountId: AccountId, input: ApplyAsDriverDTO): Promise<DriverDTO>;
  me(accountId: AccountId): Promise<DriverDTO | null>;
  update(accountId: AccountId, input: UpdateDriverDTO): Promise<DriverDTO>;
  attachDocument(accountId: AccountId, input: AttachDocumentDTO): Promise<DriverDTO>;
  /** draft|rejected|suspended -> pending_review. Refused if a document is missing. */
  submit(accountId: AccountId): Promise<DriverDTO>;

  /** Ops decision. `verified`, or `rejected`/`suspended` with a reason. */
  decide(input: {
    driverId: Uuid;
    status: Extract<DriverStatus, 'verified' | 'rejected' | 'suspended'>;
    reason?: string;
    decidedByAccountId: AccountId;
  }): Promise<DriverDTO>;
  /** The ops review queue, oldest submission first. */
  pendingReview(limit?: number): Promise<DriverDTO[]>;

  setAvailability(accountId: AccountId, input: SetAvailabilityDTO): Promise<DriverDTO>;
}

export const DRIVERS_PORT = Symbol('DRIVERS_PORT');
