import type { Capability, FormSchema, ServiceSpec, SupplierVertical } from '@justgo/contracts';

const label = (en: string, es: string, fr: string) => ({ en, es, fr });

/** Diagnostics/Scanner (§6.2): bookable diagnostics + published offers. */
export class DiagnosticsVertical implements SupplierVertical {
  readonly key = 'diagnostics';
  readonly capabilities: Capability[] = ['OFFERS_BOOKABLE_SERVICES', 'HAS_CALENDAR', 'PUBLISHES_OFFERS'];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        { key: 'center_name', type: 'text', labelI18n: label('Center name', 'Nombre del centro', 'Nom du centre'), required: true },
        { key: 'location', type: 'geo', labelI18n: label('Location', 'Ubicación', 'Emplacement'), required: true },
      ],
    };
  }

  profileSchema(): FormSchema {
    return {
      fields: [
        { key: 'obd2', type: 'boolean', labelI18n: label('OBD-II scanning', 'Escaneo OBD-II', 'Diagnostic OBD-II'), required: false },
      ],
    };
  }

  serviceSpec(): ServiceSpec {
    return { serviceTypeKeys: ['obd_scan', 'pre_purchase_inspection', 'emissions_test'], requiresVehicle: true };
  }
}
