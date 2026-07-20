import type {
  Capability,
  CatalogueSpec,
  FormSchema,
  PartRequestDTO,
  QuoteContext,
  QuoteDraft,
  SupplierVertical,
} from '@justgo/contracts';

const label = (en: string, es: string, fr: string) => ({ en, es, fr });

/**
 * Part Store (§6.2): RECEIVES_PART_REQUESTS, LISTS_PRODUCTS, HAS_DELIVERY,
 * HAS_DEALS. The core never references this class — it reaches it through
 * the VERTICAL token + registry (§9).
 */
export class PartStoreVertical implements SupplierVertical {
  readonly key = 'part_store';
  readonly capabilities: Capability[] = [
    'RECEIVES_PART_REQUESTS',
    'LISTS_PRODUCTS',
    'HAS_DELIVERY',
    'HAS_DEALS',
  ];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        {
          key: 'store_name',
          type: 'text',
          labelI18n: label('Store name', 'Nombre de la tienda', 'Nom du magasin'),
          required: true,
        },
        {
          key: 'address',
          type: 'geo',
          labelI18n: label('Store location', 'Ubicación', 'Emplacement'),
          required: true,
        },
        {
          key: 'delivery',
          type: 'boolean',
          labelI18n: label('Offers delivery', 'Ofrece entrega', 'Propose la livraison'),
          required: false,
        },
      ],
    };
  }

  profileSchema(): FormSchema {
    return {
      fields: [
        {
          key: 'specialties',
          type: 'multiselect',
          labelI18n: label('Specialties', 'Especialidades', 'Spécialités'),
          required: false,
          options: ['engine', 'braking', 'suspension', 'electrics', 'body'].map((value) => ({
            value,
            labelI18n: label(value, value, value),
          })),
        },
      ],
    };
  }

  /** Prefill draft only — a human supplier always confirms the quote (§9). */
  async quoteFor(_ctx: QuoteContext, request: PartRequestDTO): Promise<QuoteDraft> {
    return {
      kind: 'price',
      note: request.tecdocArticleId
        ? `TecDoc article ${request.tecdocArticleId}`
        : (request.freeText ?? undefined),
    };
  }

  catalogueSpec(): CatalogueSpec {
    return {
      kind: 'parts',
      categoryKeys: [
        'engine',
        'braking',
        'suspension',
        'steering',
        'electrics',
        'filters',
        'body',
        'exhaust',
        'cooling',
        'transmission',
      ],
    };
  }
}
