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
 * Wholesaler (§6.2): RECEIVES_PART_REQUESTS, LISTS_PRODUCTS, B2B_PURCHASING.
 * A second RECEIVES_PART_REQUESTS vertical — proves fan-out is capability-
 * driven, not part-store-specific (the core still names no vertical, §9).
 */
export class WholesalerVertical implements SupplierVertical {
  readonly key = 'wholesaler';
  readonly capabilities: Capability[] = [
    'RECEIVES_PART_REQUESTS',
    'LISTS_PRODUCTS',
    'B2B_PURCHASING',
  ];

  onboardingSchema(): FormSchema {
    return {
      fields: [
        { key: 'company_name', type: 'text', labelI18n: label('Company name', 'Razón social', 'Raison sociale'), required: true },
        { key: 'tax_id', type: 'text', labelI18n: label('Tax ID', 'NIF/CIF', 'Numéro fiscal'), required: true },
        { key: 'warehouse', type: 'geo', labelI18n: label('Warehouse location', 'Almacén', 'Entrepôt'), required: true },
        { key: 'min_order_value', type: 'number', labelI18n: label('Minimum order (minor units)', 'Pedido mínimo', 'Commande minimum'), required: false },
      ],
    };
  }

  profileSchema(): FormSchema {
    return {
      fields: [
        { key: 'b2b_only', type: 'boolean', labelI18n: label('B2B only', 'Solo B2B', 'B2B uniquement'), required: false },
      ],
    };
  }

  async quoteFor(_ctx: QuoteContext, request: PartRequestDTO): Promise<QuoteDraft> {
    return {
      kind: 'price',
      note: request.tecdocArticleId ? `Bulk pricing for article ${request.tecdocArticleId}` : (request.freeText ?? undefined),
    };
  }

  catalogueSpec(): CatalogueSpec {
    return {
      kind: 'parts',
      categoryKeys: ['engine', 'braking', 'suspension', 'steering', 'electrics', 'filters', 'body', 'exhaust', 'cooling', 'transmission'],
    };
  }
}
