import type { Capability, FormSchema, ServiceSpec, SupplierVertical } from '@justgo/contracts';

const label = (en: string, es: string, fr: string) => ({ en, es, fr });

/** Body & Paint (§6.2): bookable body/paint services with a calendar. */
export class BodyPaintVertical implements SupplierVertical {
  readonly key = 'body_paint';
  readonly capabilities: Capability[] = ['OFFERS_BOOKABLE_SERVICES', 'HAS_CALENDAR'];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        { key: 'shop_name', type: 'text', labelI18n: label('Shop name', 'Nombre del taller', 'Nom de l’atelier'), required: true },
        { key: 'location', type: 'geo', labelI18n: label('Location', 'Ubicación', 'Emplacement'), required: true },
      ],
    };
  }

  profileSchema(): FormSchema {
    return {
      fields: [
        { key: 'courtesy_car', type: 'boolean', labelI18n: label('Courtesy car', 'Coche de cortesía', 'Voiture de courtoisie'), required: false },
      ],
    };
  }

  serviceSpec(): ServiceSpec {
    return { serviceTypeKeys: ['dent_repair', 'full_respray', 'paint_touch_up'], requiresVehicle: true };
  }
}
