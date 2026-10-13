/** Events emitted by drivers (§12). Versioned and additive. */

export const DRIVER_SUBMITTED = 'drivers.DriverSubmitted';
export interface DriverSubmittedV1 {
  driverId: string;
  accountId: string;
  supplierId: string | null;
  fullName: string;
}

export const DRIVER_VERIFIED = 'drivers.DriverVerified';
export interface DriverVerifiedV1 {
  driverId: string;
  accountId: string;
  supplierId: string | null;
  verifiedAt: string;
}

export const DRIVER_REFUSED = 'drivers.DriverRefused';
export interface DriverRefusedV1 {
  driverId: string;
  accountId: string;
  /** `rejected` (never accepted) or `suspended` (was, no longer). */
  status: 'rejected' | 'suspended';
  reason: string;
}
