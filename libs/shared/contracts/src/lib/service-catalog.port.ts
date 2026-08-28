/**
 * Data-driven service catalogue (§4.6, §7 catalogue.service_types). The
 * catalogue module owns the rows; other modules (reservations) validate a
 * service_type_key and read its booking rules ONLY through this port — never
 * by touching the catalogue schema (§17.4).
 */
export interface ServiceTypeDTO {
  key: string;
  verticalKey: string;
  labelI18n: Record<string, string>;
  pricingModel: 'fixed' | 'quote' | 'hourly';
  requiresCalendar: boolean;
  requiresVehicle: boolean;
  active: boolean;
}

export interface ServiceCatalogPort {
  getServiceType(key: string): Promise<ServiceTypeDTO | null>;
  listServiceTypes(verticalKey?: string): Promise<ServiceTypeDTO[]>;
}

export const SERVICE_CATALOG_PORT = Symbol('SERVICE_CATALOG_PORT');
