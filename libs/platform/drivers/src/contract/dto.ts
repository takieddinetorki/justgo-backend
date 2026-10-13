import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

export type DriverStatus = 'draft' | 'pending_review' | 'verified' | 'rejected' | 'suspended';

export type DriverDocumentKind = 'licence_front' | 'licence_back' | 'selfie' | 'id_card';

export interface DriverDocumentDTO {
  id: Uuid;
  kind: DriverDocumentKind;
  bucket: string;
  path: string;
  uploadedAt: string;
}

export interface DriverAvailabilityDTO {
  isOnline: boolean;
  lat: number | null;
  lng: number | null;
  lastSeenAt: string;
}

export interface DriverDTO {
  id: Uuid;
  accountId: AccountId;
  /** The business they drive for. Null for an independent operator. */
  supplierId: SupplierId | null;
  fullName: string;
  phone: string | null;
  licenceNumber: string | null;
  licenceExpiresOn: string | null;
  status: DriverStatus;
  /** Why they were rejected or suspended — always set in those states. */
  decisionReason: string | null;
  decidedAt: string | null;
  verifiedAt: string | null;
  documents: DriverDocumentDTO[];
  availability: DriverAvailabilityDTO | null;
  /** Document kinds still needed before this profile can be submitted. */
  missingDocuments: DriverDocumentKind[];
  createdAt: string;
  updatedAt: string;
}

export interface ApplyAsDriverDTO {
  fullName: string;
  phone?: string;
  licenceNumber?: string;
  licenceExpiresOn?: string;
  supplierId?: string;
}

export interface UpdateDriverDTO {
  fullName?: string;
  phone?: string;
  licenceNumber?: string;
  licenceExpiresOn?: string;
}

export interface AttachDocumentDTO {
  kind: DriverDocumentKind;
  bucket: string;
  path: string;
}

export interface SetAvailabilityDTO {
  isOnline: boolean;
  lat?: number;
  lng?: number;
}
