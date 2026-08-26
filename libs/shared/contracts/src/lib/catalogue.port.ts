/**
 * Catalogue / TecDoc anti-corruption contract (§10). TecDoc (TecAlliance) is
 * the parts authority; it is a licensed, caching-restricted external service
 * exposed behind THIS port only — nothing else in the system calls TecDoc
 * directly (§10, §17.4). We persist only reference IDs long-term; never a
 * bulk copy of TecDoc data.
 *
 * i18n labels are keyed by locale ({ en, es, fr }) to cover the trilingual
 * requirement (§10.1).
 */
export interface I18nLabel {
  en: string;
  es: string;
  fr: string;
}

/** Vehicle resolution query (manufacturer → model → KType), §10.1. */
export interface VehicleQuery {
  manufacturer?: string;
  model?: string;
  year?: number;
  /** VIN lookup availability is an Open Question (§21.2); optional here. */
  vin?: string;
}

/** A resolved vehicle-type candidate. `kType` is the load-bearing id (§22). */
export interface VehicleTypeRef {
  kType: number;
  manufacturerId: number;
  modelId: number;
  manufacturer: string;
  model: string;
  typeName: string;
  fromYear: number | null;
  toYear: number | null;
  powerKw: number | null;
  fuel: string | null;
}

export interface AssemblyGroup {
  id: number;
  /** our stable category key (mirrors TecDoc), e.g. 'braking'. */
  key: string;
  label: I18nLabel;
  parentId: number | null;
}

export interface ArticleQuery {
  kType?: number;
  assemblyGroupId?: number;
  /** OE number or free text. */
  oe?: string;
  text?: string;
  limit?: number;
}

export interface ArticleRef {
  articleId: number;
  name: string;
  brand: string;
  reference: string;
  assemblyGroupId: number | null;
}

export interface ArticleAttribute {
  key: string;
  label: I18nLabel;
  value: string;
}

export interface ArticleDetail extends ArticleRef {
  attributes: ArticleAttribute[];
  images: string[];
  oeNumbers: string[];
}

export interface CataloguePort {
  resolveVehicle(query: VehicleQuery): Promise<VehicleTypeRef[]>;
  assemblyGroups(kType: number): Promise<AssemblyGroup[]>;
  searchArticles(query: ArticleQuery): Promise<ArticleRef[]>;
  articleDetail(articleId: number): Promise<ArticleDetail | null>;
  /** OE number or article id → equivalents; powers "Find Best Alternative" (§10.1). */
  crossReferences(articleOrOe: string | number): Promise<ArticleRef[]>;
}

export const CATALOGUE_PORT = Symbol('CATALOGUE_PORT');
