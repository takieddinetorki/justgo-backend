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

export const ASSISTANCE_CHARGED = 'assistance.AssistanceCharged';
/**
 * A call-out was completed AND PRICED. The facture is issued off this.
 *
 * Same split as reservations: finishing a tow and charging for it are
 * separate facts. A driver can be sent out as a courtesy, and the price
 * of a tow depends on the distance actually driven, so the figure often
 * arrives after the job is closed rather than with it.
 */
export interface AssistanceChargedV1 {
  assistanceId: string;
  clientAccountId: string;
  supplierId: string;
  amountMinor: number;
  currency: string;
  serviceType: string;
}
