import type { AccountId, SupplierId, Uuid } from '@justgo/kernel';

export type CaseStatus = 'open' | 'under_review' | 'resolved' | 'rejected' | 'withdrawn';

export type CaseCategory =
  | 'not_delivered'
  | 'wrong_part'
  | 'damaged'
  | 'quality'
  | 'overcharged'
  | 'no_show'
  | 'behaviour'
  | 'other';

export type CaseSubjectType = 'order' | 'reservation' | 'assistance' | 'listing' | 'quote';

/** Who said it, as recorded at the time — never re-derived. */
export type CaseAuthorRole = 'claimant' | 'respondent' | 'ops';

export interface CaseAttachmentDTO {
  id: Uuid;
  bucket: string;
  path: string;
  uploadedByAccountId: AccountId;
  createdAt: string;
}

export interface CaseMessageDTO {
  id: Uuid;
  caseId: Uuid;
  authorAccountId: AccountId;
  authorRole: CaseAuthorRole;
  body: string;
  /** Ops-only note. Never present in a claimant or respondent response. */
  internal: boolean;
  createdAt: string;
}

export interface CaseDTO {
  id: Uuid;
  /** RCL-2026-000123 — what a human quotes on the phone. */
  reference: string;
  claimantAccountId: AccountId;
  /** Null when the complaint is against the platform rather than a business. */
  respondentSupplierId: SupplierId | null;
  subjectType: CaseSubjectType | null;
  subjectId: Uuid | null;
  category: CaseCategory;
  title: string;
  body: string;
  status: CaseStatus;
  /** Why it closed. Always set on `resolved` and `rejected`. */
  resolution: string | null;
  attachments: CaseAttachmentDTO[];
  messageCount: number;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileCaseDTO {
  category: CaseCategory;
  title: string;
  body: string;
  respondentSupplierId?: string;
  subjectType?: CaseSubjectType;
  subjectId?: string;
  attachments?: { bucket: string; path: string }[];
}

export interface CaseQuery {
  status?: CaseStatus;
  limit?: number;
  cursor?: string;
}

export interface CasePage {
  items: CaseDTO[];
  nextCursor: string | null;
}
