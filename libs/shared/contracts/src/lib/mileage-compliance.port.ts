/**
 * Is this account allowed through, or is it behind the mileage lock?
 *
 * The client app hides notifications when any of the account's cars has
 * not had its mileage stated for 30 days. A hidden screen is a UI
 * decision and nothing more — the endpoints behind it answer anyone
 * holding the token, so the rule only really exists if the server
 * applies it too.
 *
 * It is a PORT because the answer is computed from
 * `vehicles.vehicles.mileage_updated_at`, and a guard cannot reach into
 * another module's schema (§17.4). The vehicles module answers; the
 * guard asks. Bound in the composition root (§21.1), which keeps the
 * vehicles module extractable.
 */
export interface MileageComplianceDTO {
  locked: boolean;
  reason: 'MILEAGE_UPDATE_REQUIRED' | null;
  /** The car that caused the lock, so the app can open it directly. */
  vehicleId: string | null;
  lastUpdatedAt: string | null;
  dueAt: string | null;
}

export interface MileageCompliancePort {
  /** Never throws for an unknown account — an account with no cars is open. */
  complianceFor(accountId: string): Promise<MileageComplianceDTO>;
}

export const MILEAGE_COMPLIANCE_PORT = Symbol('MILEAGE_COMPLIANCE_PORT');
