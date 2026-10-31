import { ValidationError, type AccountId, type Uuid } from '@justgo/kernel';
import type { AvatarRefDTO, ProfilePatchDTO } from '../contract/dto';

const LOCALES = ['en', 'es', 'fr'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Domain entity — repositories return this, never rows (§17.1). */
export class Account {
  constructor(
    readonly id: AccountId,
    readonly authUserId: Uuid,
    public firstName: string | null,
    public familyName: string | null,
    public email: string | null,
    public phone: string | null,
    public locale: string,
    readonly roles: string[],
    readonly createdAt: Date,
    public dob: string | null = null,
    public city: string | null = null,
    public country: string | null = null,
    public avatar: AvatarRefDTO | null = null,
    public deletedAt: Date | null = null,
  ) {}

  /** `undefined` leaves a field alone; `null` clears it. */
  applyProfilePatch(patch: ProfilePatchDTO): void {
    if (this.deletedAt) {
      throw new ValidationError('This account has been closed and can no longer be edited');
    }
    if (patch.locale !== undefined) {
      if (!LOCALES.includes(patch.locale)) {
        throw new ValidationError(`Unsupported locale "${patch.locale}"`, { supported: LOCALES });
      }
      this.locale = patch.locale;
    }
    if (patch.dob !== undefined && patch.dob !== null) {
      if (!ISO_DATE.test(patch.dob) || Number.isNaN(Date.parse(patch.dob))) {
        throw new ValidationError('dob must be a calendar date, YYYY-MM-DD');
      }
      /*
        A date of birth in the future is a typo every time, and it is worth
        catching here rather than discovering it as a negative age in
        whatever screen renders it.
      */
      if (Date.parse(patch.dob) > Date.now()) {
        throw new ValidationError('dob cannot be in the future');
      }
    }

    if (patch.firstName !== undefined) this.firstName = patch.firstName.trim() || null;
    if (patch.familyName !== undefined) this.familyName = patch.familyName.trim() || null;
    if (patch.phone !== undefined) this.phone = patch.phone?.trim() || null;
    if (patch.email !== undefined) this.email = patch.email?.trim() || null;
    if (patch.dob !== undefined) this.dob = patch.dob;
    if (patch.city !== undefined) this.city = patch.city?.trim() || null;
    if (patch.country !== undefined) this.country = patch.country?.trim().toUpperCase() || null;
    if (patch.avatar !== undefined) this.avatar = patch.avatar;
  }

  /**
   * Close the account.
   *
   * Anonymise, not delete. The row is referenced by orders, reservations,
   * reclamations, messages and reviews — all of which belong to the OTHER
   * party as much as to this one — so removing it would destroy a supplier's
   * record of sales they made. Every one of those references is by id, and
   * every screen that shows a name reads it from here, so blanking these
   * columns removes the person from the product everywhere at once.
   *
   * Two things are deliberately untouched:
   *
   * - **Issued documents.** An invoice renders from a snapshot taken when it
   *   was issued, sealed and signed over its exact bytes. The buyer's name
   *   stays printed there, under a number in a gapless fiscal series,
   *   because that is what makes it a tax document — and because editing the
   *   bytes would break the signature that proves it was not edited.
   * - **The GoTrue credential.** `auth.users` is another module's schema
   *   (§17.4) and a sign-in is not personal data this module owns. The row
   *   below loses every role instead, so a login still succeeds and then
   *   reaches nothing.
   */
  anonymise(at: Date): void {
    this.firstName = null;
    this.familyName = null;
    this.email = null;
    this.phone = null;
    this.dob = null;
    this.city = null;
    this.country = null;
    this.avatar = null;
    this.deletedAt = at;
  }

  get isClosed(): boolean {
    return this.deletedAt !== null;
  }
}
