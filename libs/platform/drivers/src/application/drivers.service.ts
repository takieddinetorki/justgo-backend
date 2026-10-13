import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type AccountId,
  type Uuid,
} from '@justgo/kernel';
import type { DriversPort } from '../contract/drivers.port';
import type {
  ApplyAsDriverDTO,
  AttachDocumentDTO,
  DriverDTO,
  DriverStatus,
  SetAvailabilityDTO,
  UpdateDriverDTO,
} from '../contract/dto';
import { licenceExpired, missingDocuments } from '../domain/driver-state';
import { PgDriversRepository } from '../infra/pg-drivers.repository';

export const DRIVERS_REPOSITORY = Symbol('DRIVERS_REPOSITORY');

const MAX_NAME = 160;

/**
 * The bucket KYC documents live in.
 *
 * Its own bucket, not `avatars` or `part-photos`: a driving licence and a
 * selfie are the most sensitive things this product stores, and they must not
 * sit beside objects whose read rules are looser. An allow-list of one, held
 * as a PLAIN ARRAY — SWC rewrites a Set spread as `[].concat(set)`, which has
 * silently emptied an allow-list twice in this codebase.
 */
const DOCUMENT_BUCKETS: readonly string[] = ['driver-documents'];

@Injectable()
export class DriversService implements DriversPort {
  constructor(@Inject(DRIVERS_REPOSITORY) private readonly repo: PgDriversRepository) {}

  private assertName(name: string | undefined): void {
    if (name !== undefined && name.trim().length === 0) {
      throw new ValidationError('A driver needs a name');
    }
    if (name !== undefined && name.length > MAX_NAME) {
      throw new ValidationError(`The name may not exceed ${MAX_NAME} characters`);
    }
  }

  /** ISO date, and not already in the past. */
  private assertLicenceDate(date: string | undefined): void {
    if (date === undefined) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ValidationError('licenceExpiresOn must be an ISO date (YYYY-MM-DD)');
    }
    if (licenceExpired(date)) {
      throw new BusinessRuleError('LICENCE_EXPIRED', 'That licence has already expired');
    }
  }

  async apply(accountId: AccountId, input: ApplyAsDriverDTO): Promise<DriverDTO> {
    this.assertName(input.fullName);
    this.assertLicenceDate(input.licenceExpiresOn);
    return this.repo.apply(accountId, { ...input, fullName: input.fullName.trim() });
  }

  async me(accountId: AccountId): Promise<DriverDTO | null> {
    return this.repo.me(accountId);
  }

  async update(accountId: AccountId, input: UpdateDriverDTO): Promise<DriverDTO> {
    this.assertName(input.fullName);
    this.assertLicenceDate(input.licenceExpiresOn);

    const current = await this.repo.me(accountId);
    if (!current) throw new NotFoundError('Driver', accountId);
    /*
      Details are frozen while a reviewer is looking. Otherwise a driver could
      swap the licence number after the photos were approved, and the
      verification would attest a document nobody checked.
    */
    if (current.status === 'pending_review') {
      throw new BusinessRuleError(
        'UNDER_REVIEW',
        'Your details cannot change while your application is under review',
      );
    }
    return this.repo.update(accountId, input);
  }

  async attachDocument(accountId: AccountId, input: AttachDocumentDTO): Promise<DriverDTO> {
    if (!DOCUMENT_BUCKETS.includes(input.bucket)) {
      throw new ValidationError(
        `Verification documents must come from the "${DOCUMENT_BUCKETS[0]}" bucket`,
      );
    }
    /*
      The uploader namespaces every object under the caller's account id.
      Re-checking it here stops a driver submitting somebody else's licence
      photo — which is the single thing this whole flow exists to prevent.
    */
    if (!input.path.startsWith(`${accountId}/`)) {
      throw new ForbiddenError('Verification documents must be your own uploads');
    }

    const current = await this.repo.me(accountId);
    if (!current) throw new NotFoundError('Driver', accountId);
    if (current.status === 'pending_review') {
      throw new BusinessRuleError(
        'UNDER_REVIEW',
        'Documents cannot change while your application is under review',
      );
    }
    return this.repo.attachDocument(accountId, input);
  }

  async submit(accountId: AccountId): Promise<DriverDTO> {
    const current = await this.repo.me(accountId);
    if (!current) throw new NotFoundError('Driver', accountId);

    /*
      The gate. A submission missing the licence front or the selfie cannot be
      decided — a reviewer would be approving a photograph of a licence with
      nothing tying it to the person holding the phone. Naming the missing
      kinds in the error is what lets the app send the user back to the right
      step instead of to a generic failure.
    */
    const missing = missingDocuments(current.documents.map((d) => d.kind));
    if (missing.length > 0) {
      throw new BusinessRuleError(
        'DOCUMENTS_INCOMPLETE',
        `Still needed before review: ${missing.join(', ')}`,
        { missing },
      );
    }
    if (licenceExpired(current.licenceExpiresOn)) {
      throw new BusinessRuleError('LICENCE_EXPIRED', 'That licence has expired');
    }
    return this.repo.submit(accountId);
  }

  async decide(input: {
    driverId: Uuid;
    status: Extract<DriverStatus, 'verified' | 'rejected' | 'suspended'>;
    reason?: string;
    decidedByAccountId: AccountId;
  }): Promise<DriverDTO> {
    const reason = input.reason?.trim() ?? '';
    /*
      A refusal with no reason is unactionable: the driver cannot tell whether
      to retake a photo or give up, so they contact support instead. The
      database enforces this too; failing here gives a 422 with a field rather
      than a constraint violation.
    */
    if (input.status !== 'verified' && reason.length === 0) {
      throw new ValidationError(`A ${input.status} decision requires a reason`);
    }
    return this.repo.decide({ ...input, reason });
  }

  async pendingReview(limit = 50): Promise<DriverDTO[]> {
    return this.repo.pendingReview(Math.min(Math.max(limit, 1), 200));
  }

  async setAvailability(accountId: AccountId, input: SetAvailabilityDTO): Promise<DriverDTO> {
    const current = await this.repo.me(accountId);
    if (!current) throw new NotFoundError('Driver', accountId);

    /*
      ONLY A VERIFIED DRIVER MAY GO ONLINE. This is also enforced by the
      `driver.work` permission, which a reactor grants on verification — but
      the permission can be stale for the life of a token, and this check
      reads the current row. Going offline is always allowed: it must never
      be possible to get stuck online.
    */
    if (input.isOnline && current.status !== 'verified') {
      throw new ForbiddenError(
        `A ${current.status} driver cannot go online — verification is required first`,
      );
    }
    if (input.isOnline && licenceExpired(current.licenceExpiresOn)) {
      throw new BusinessRuleError('LICENCE_EXPIRED', 'Your licence has expired');
    }
    if ((input.lat === undefined) !== (input.lng === undefined)) {
      throw new ValidationError('lat and lng must be provided together');
    }
    return this.repo.setAvailability(accountId, input);
  }
}
