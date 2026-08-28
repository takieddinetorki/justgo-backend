import type { Capability, CatalogueSpec, FormSchema, SupplierVertical } from '@justgo/contracts';

const label = (en: string, es: string, fr: string) => ({ en, es, fr });

/** Car Showroom/Dealer (§6.2): lists vehicles, buyer contact, deals. */
export class ShowroomVertical implements SupplierVertical {
  readonly key = 'showroom';
  readonly capabilities: Capability[] = ['LISTS_VEHICLES', 'BUYER_CONTACT', 'HAS_DEALS'];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        { key: 'dealership_name', type: 'text', labelI18n: label('Dealership name', 'Nombre del concesionario', 'Nom du concessionnaire'), required: true },
        { key: 'location', type: 'geo', labelI18n: label('Location', 'Ubicación', 'Emplacement'), required: true },
      ],
    };
  }

  profileSchema(): FormSchema {
    return {
      fields: [
        { key: 'brands', type: 'multiselect', labelI18n: label('Brands sold', 'Marcas', 'Marques'), required: false },
      ],
    };
  }

  catalogueSpec(): CatalogueSpec {
    return { kind: 'vehicles', categoryKeys: [] };
  }
}
