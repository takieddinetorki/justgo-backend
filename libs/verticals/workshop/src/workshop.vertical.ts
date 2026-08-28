import type {
  Capability,
  FormSchema,
  ServiceSpec,
  SupplierVertical,
} from '@justgo/contracts';

const label = (en: string, es: string, fr: string) => ({ en, es, fr });

/** Workshop/Garage (§6.2): installs parts + bookable services with a calendar. */
export class WorkshopVertical implements SupplierVertical {
  readonly key = 'workshop';
  readonly capabilities: Capability[] = ['OFFERS_BOOKABLE_SERVICES', 'HAS_CALENDAR', 'INSTALLS_PARTS'];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        { key: 'garage_name', type: 'text', labelI18n: label('Garage name', 'Nombre del taller', 'Nom du garage'), required: true },
        { key: 'location', type: 'geo', labelI18n: label('Location', 'Ubicación', 'Emplacement'), required: true },
        { key: 'bays', type: 'number', labelI18n: label('Number of bays', 'Número de bahías', 'Nombre de baies'), required: false },
      ],
    };
  }

  profileSchema(): FormSchema {
    return {
      fields: [
        { key: 'installs_supplied_parts', type: 'boolean', labelI18n: label('Installs client-supplied parts', 'Instala piezas del cliente', 'Pose des pièces fournies'), required: false },
      ],
    };
  }

  serviceSpec(): ServiceSpec {
    return { serviceTypeKeys: ['oil_change', 'brake_service', 'general_repair', 'part_installation'], requiresVehicle: true };
  }
}
