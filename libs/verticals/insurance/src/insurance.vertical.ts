import type { Capability, FormSchema, SupplierVertical } from '@justgo/contracts';

const label = (en: string, es: string, fr: string) => ({ en, es, fr });

/** Insurance (§6.2): publishes policies + offers. Policy/offer data model is
 *  an Open Question for beta scope (§21.5) — the vertical registers now; the
 *  policy tables are added when that scope is confirmed. */
export class InsuranceVertical implements SupplierVertical {
  readonly key = 'insurance';
  readonly capabilities: Capability[] = ['PUBLISHES_POLICIES', 'PUBLISHES_OFFERS'];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        { key: 'insurer_name', type: 'text', labelI18n: label('Insurer name', 'Nombre de la aseguradora', 'Nom de l assureur'), required: true },
        { key: 'license_no', type: 'text', labelI18n: label('License number', 'Numero de licencia', 'Numero de licence'), required: true },
      ],
    };
  }

  profileSchema(): FormSchema {
    return {
      fields: [
        { key: 'lines', type: 'multiselect', labelI18n: label('Insurance lines', 'Ramos', 'Branches'), required: false,
          options: ['auto', 'liability', 'roadside'].map((v) => ({ value: v, labelI18n: label(v, v, v) })) },
      ],
    };
  }
}
