import type { AccountId, Uuid } from '@justgo/kernel';

export interface AccountDTO {
  id: AccountId;
  authUserId: Uuid;
  firstName: string | null;
  familyName: string | null;
  email: string | null;
  phone: string | null;
  locale: string;
  roles: string[];
  createdAt: string; // UTC ISO-8601
}

export interface ProfilePatchDTO {
  firstName?: string;
  familyName?: string;
  phone?: string;
  locale?: string;
}
