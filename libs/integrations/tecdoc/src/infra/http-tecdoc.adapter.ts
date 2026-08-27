import { Injectable } from '@nestjs/common';
import type {
  ArticleDetail,
  ArticleQuery,
  ArticleRef,
  AssemblyGroup,
  CataloguePort,
  I18nLabel,
  VehicleQuery,
  VehicleTypeRef,
} from '@justgo/contracts';
import type { HttpTransport } from './http-transport';

/**
 * Real TecDoc Catalogue API adapter (§10). Talks to TecDoc's REST/JSON
 * endpoints through an injectable transport and maps the wire shape into our
 * domain contract — the anti-corruption layer. We store only reference IDs
 * long-term; this adapter never persists a bulk copy (§10.4, §17.4).
 *
 * NOTE (Open Question §21.2): TecAlliance's exact endpoint/field names and
 * auth are confirmed at integration time. The request/response shapes here
 * follow the documented Catalogue API structure and are isolated to this
 * file, so aligning them touches nothing else.
 */

interface RawVehicle {
  vehicleId?: number;
  linkageTargetId?: number;
  manufacturerId: number;
  modelId: number;
  manufacturerName: string;
  modelName: string;
  typeName?: string;
  description?: string;
  yearOfConstructionFrom?: string | number | null;
  yearOfConstructionTo?: string | number | null;
  powerKw?: number | null;
  fuelType?: string | null;
}

interface RawGroup {
  assemblyGroupNodeId: number;
  assemblyGroupName: string;
  assemblyGroupNameEs?: string;
  assemblyGroupNameFr?: string;
  parentNodeId?: number | null;
  categoryKey?: string;
}

interface RawArticle {
  articleId?: number;
  legacyArticleId?: number;
  articleNumber: string;
  mfrName?: string;
  dataSupplierName?: string;
  genericArticleDescription?: string;
  assemblyGroupNodeId?: number | null;
}

interface RawArticleDetail extends RawArticle {
  articleCriteria?: { criteriaDescription: string; formattedValue: string }[];
  images?: { imageURL2000?: string; imageURL?: string }[];
  oemNumbers?: { articleOemNo: string }[];
}

const KTYPE_OF = (v: RawVehicle): number => v.linkageTargetId ?? v.vehicleId ?? 0;
const ARTICLE_ID_OF = (a: RawArticle): number => a.articleId ?? a.legacyArticleId ?? 0;
const yr = (v: string | number | null | undefined): number | null =>
  v == null ? null : Number(String(v).slice(0, 4)) || null;

function label(en: string, es?: string, fr?: string): I18nLabel {
  return { en, es: es ?? en, fr: fr ?? en };
}

@Injectable()
export class HttpTecDocAdapter implements CataloguePort {
  constructor(private readonly http: HttpTransport) {}

  async resolveVehicle(query: VehicleQuery): Promise<VehicleTypeRef[]> {
    const res = await this.http.post<{ data?: RawVehicle[] }>({
      path: 'vehicles/search',
      body: {
        manufacturerName: query.manufacturer,
        modelName: query.model,
        year: query.year,
        vin: query.vin,
      },
    });
    return (res.data ?? []).map((v) => ({
      kType: KTYPE_OF(v),
      manufacturerId: v.manufacturerId,
      modelId: v.modelId,
      manufacturer: v.manufacturerName,
      model: v.modelName,
      typeName: v.typeName ?? v.description ?? '',
      fromYear: yr(v.yearOfConstructionFrom),
      toYear: yr(v.yearOfConstructionTo),
      powerKw: v.powerKw ?? null,
      fuel: v.fuelType ?? null,
    }));
  }

  async assemblyGroups(kType: number): Promise<AssemblyGroup[]> {
    const res = await this.http.post<{ data?: RawGroup[] }>({
      path: 'assembly-groups',
      body: { linkageTargetId: kType },
    });
    return (res.data ?? []).map((g) => ({
      id: g.assemblyGroupNodeId,
      key: g.categoryKey ?? String(g.assemblyGroupNodeId),
      label: label(g.assemblyGroupName, g.assemblyGroupNameEs, g.assemblyGroupNameFr),
      parentId: g.parentNodeId ?? null,
    }));
  }

  async searchArticles(query: ArticleQuery): Promise<ArticleRef[]> {
    const res = await this.http.post<{ data?: RawArticle[] }>({
      path: 'articles/search',
      body: {
        linkageTargetId: query.kType,
        assemblyGroupNodeId: query.assemblyGroupId,
        oeNumber: query.oe,
        searchQuery: query.text,
        perPage: query.limit ?? 50,
      },
    });
    return (res.data ?? []).map((a) => this.toRef(a));
  }

  async articleDetail(articleId: number): Promise<ArticleDetail | null> {
    const res = await this.http.post<{ data?: RawArticleDetail }>({
      path: 'articles/details',
      body: { articleId },
    });
    const a = res.data;
    if (!a) return null;
    return {
      ...this.toRef(a),
      attributes: (a.articleCriteria ?? []).map((c) => ({
        key: c.criteriaDescription,
        label: label(c.criteriaDescription),
        value: c.formattedValue,
      })),
      images: (a.images ?? []).map((i) => i.imageURL2000 ?? i.imageURL ?? '').filter(Boolean),
      oeNumbers: (a.oemNumbers ?? []).map((o) => o.articleOemNo),
    };
  }

  async crossReferences(articleOrOe: string | number): Promise<ArticleRef[]> {
    const res = await this.http.post<{ data?: RawArticle[] }>({
      path: 'articles/cross-references',
      body: typeof articleOrOe === 'number' ? { articleId: articleOrOe } : { oeNumber: articleOrOe },
    });
    return (res.data ?? []).map((a) => this.toRef(a));
  }

  private toRef(a: RawArticle): ArticleRef {
    return {
      articleId: ARTICLE_ID_OF(a),
      name: a.genericArticleDescription ?? a.articleNumber,
      brand: a.mfrName ?? a.dataSupplierName ?? '',
      reference: a.articleNumber,
      assemblyGroupId: a.assemblyGroupNodeId ?? null,
    };
  }
}
