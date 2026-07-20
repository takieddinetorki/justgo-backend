import { ValidationError, type AccountId, type Uuid } from '@justgo/kernel';

const LOCALES = ['en', 'es', 'fr'];

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
  ) {}

  applyProfilePatch(patch: {
    firstName?: string;
    familyName?: string;
    phone?: string;
    locale?: string;
  }): void {
    if (patch.locale !== undefined) {
      if (!LOCALES.includes(patch.locale)) {
        throw new ValidationError(`Unsupported locale "${patch.locale}"`, { supported: LOCALES });
      }
      this.locale = patch.locale;
    }
    if (patch.firstName !== undefined) this.firstName = patch.firstName.trim() || null;
    if (patch.familyName !== undefined) this.familyName = patch.familyName.trim() || null;
    if (patch.phone !== undefined) this.phone = patch.phone.trim() || null;
  }
}
