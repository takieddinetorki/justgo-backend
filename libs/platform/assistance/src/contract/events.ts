export const ASSISTANCE_REQUESTED = 'assistance.AssistanceRequested';
export interface AssistanceRequestedV1 {
  assistanceId: string;
  clientAccountId: string;
  serviceType: string;
  lat: number;
  lng: number;
}

export const ASSISTANCE_STATUS_CHANGED = 'assistance.AssistanceStatusChanged';
export interface AssistanceStatusChangedV1 {
  assistanceId: string;
  clientAccountId: string;
  assignedSupplierId: string | null;
  from: string;
  to: string;
}
