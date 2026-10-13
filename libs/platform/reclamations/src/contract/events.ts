/** Events emitted by reclamations (§12). Versioned and additive. */

export const CASE_FILED = 'reclamations.CaseFiled';
export interface CaseFiledV1 {
  caseId: string;
  reference: string;
  claimantAccountId: string;
  /** Null when the complaint is against the platform. */
  respondentSupplierId: string | null;
  category: string;
  title: string;
  subjectType: string | null;
  subjectId: string | null;
}

export const CASE_STATUS_CHANGED = 'reclamations.CaseStatusChanged';
export interface CaseStatusChangedV1 {
  caseId: string;
  reference: string;
  claimantAccountId: string;
  respondentSupplierId: string | null;
  from: string;
  to: string;
  /** Set when the new state closes the case. */
  resolution: string | null;
}

export const CASE_MESSAGE_POSTED = 'reclamations.CaseMessagePosted';
export interface CaseMessagePostedV1 {
  caseId: string;
  reference: string;
  messageId: string;
  authorAccountId: string;
  authorRole: 'claimant' | 'respondent' | 'ops';
  /**
   * Accounts to notify, which never includes the author.
   *
   * Only the accounts this module KNOWS. The respondent is a business, and
   * resolving a supplier to the people who should hear about it means reading
   * the suppliers schema — which this module may not do (§17.4). So the
   * supplier id travels on the event and a notification reactor resolves it.
   */
  notifyAccountIds: string[];
  /** Null when the complaint is against the platform, or when the respondent
   *  is the one who wrote this message. */
  notifySupplierId: string | null;
  preview: string;
}
