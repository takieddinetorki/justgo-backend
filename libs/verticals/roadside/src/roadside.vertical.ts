import type { Capability, DispatchSpec, FormSchema, SupplierVertical } from '@justgo/contracts';

const label = (en: string, es: string, fr: string) => ({ en, es, fr });

/** Roadside Assistance (§6.2): dispatch + location routing + custom profile. */
export class RoadsideVertical implements SupplierVertical {
  readonly key = 'roadside';
  readonly capabilities: Capability[] = ['PROVIDES_DISPATCH', 'HAS_LOCATION_ROUTING', 'CUSTOM_PROFILE'];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        { key: 'operator_name', type: 'text', labelI18n: label('Operator name', 'Nombre del operador', 'Nom de l operateur'), required: true },
        { key: 'base_location', type: 'geo', labelI18n: label('Base location', 'Base', 'Base'), required: true },
      ],
    };
  }

  profileSchema(): FormSchema {
    // CUSTOM_PROFILE: roadside carries driver + truck details (§9 example).
    return {
      fields: [
        { key: 'driver_name', type: 'text', labelI18n: label('Driver name', 'Nombre del conductor', 'Nom du chauffeur'), required: true },
        { key: 'truck_plate', type: 'text', labelI18n: label('Truck plate', 'Matricula del camion', 'Plaque du camion'), required: true },
        { key: 'truck_type', type: 'select', labelI18n: label('Truck type', 'Tipo de camion', 'Type de camion'), required: false,
          options: ['flatbed', 'wheel_lift', 'wrecker'].map((v) => ({ value: v, labelI18n: label(v, v, v) })) },
      ],
    };
  }

  dispatchSpec(): DispatchSpec {
    // Matching rules (radius/pricing) are Open Questions §21.1/§21.4 —
    // configurable here, not hard-coded into the core.
    return { maxRadiusKm: 50, requiresLiveLocation: true };
  }
}
