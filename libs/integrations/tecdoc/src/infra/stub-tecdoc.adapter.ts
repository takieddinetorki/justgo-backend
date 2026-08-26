import { Injectable } from '@nestjs/common';
import type {
  ArticleDetail,
  ArticleQuery,
  ArticleRef,
  AssemblyGroup,
  CataloguePort,
  VehicleQuery,
  VehicleTypeRef,
} from '@justgo/contracts';
import { ARTICLES, ASSEMBLY_GROUPS, GROUPS_BY_KTYPE, VEHICLES } from './fixtures';

const norm = (s: string): string => s.trim().toLowerCase();

function toRef(a: ArticleDetail): ArticleRef {
  return {
    articleId: a.articleId,
    name: a.name,
    brand: a.brand,
    reference: a.reference,
    assemblyGroupId: a.assemblyGroupId,
  };
}

/**
 * In-memory stub of the TecDoc Catalogue API (§10, §19). Same contract as the
 * real adapter, so Phase 2 swaps this for the live REST client + circuit
 * breaker + Redis short-TTL cache (§10.4/§10.5) with no caller changes.
 */
@Injectable()
export class StubTecDocAdapter implements CataloguePort {
  async resolveVehicle(query: VehicleQuery): Promise<VehicleTypeRef[]> {
    const mfr = query.manufacturer ? norm(query.manufacturer) : null;
    const model = query.model ? norm(query.model) : null;
    return VEHICLES.filter((v) => {
      if (mfr && !norm(v.manufacturer).includes(mfr)) return false;
      if (model && !norm(v.model).includes(model)) return false;
      if (query.year != null) {
        const from = v.fromYear ?? -Infinity;
        const to = v.toYear ?? Infinity;
        if (query.year < from || query.year > to) return false;
      }
      return true;
    });
  }

  async assemblyGroups(kType: number): Promise<AssemblyGroup[]> {
    const ids = GROUPS_BY_KTYPE[kType];
    if (!ids) return [];
    return ASSEMBLY_GROUPS.filter((g) => ids.includes(g.id));
  }

  async searchArticles(query: ArticleQuery): Promise<ArticleRef[]> {
    const text = query.text ? norm(query.text) : null;
    const oe = query.oe ? norm(query.oe) : null;
    const limit = query.limit ?? 50;
    const results = ARTICLES.filter((a) => {
      if (query.kType != null && !a.fitsKTypes.includes(query.kType)) return false;
      if (query.assemblyGroupId != null && a.assemblyGroupId !== query.assemblyGroupId) return false;
      if (oe && !a.oeNumbers.some((n) => norm(n) === oe)) return false;
      if (text) {
        const hay = `${a.name} ${a.brand} ${a.reference}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    return results.slice(0, limit).map(toRef);
  }

  async articleDetail(articleId: number): Promise<ArticleDetail | null> {
    const a = ARTICLES.find((x) => x.articleId === articleId);
    if (!a) return null;
    // strip the fixture-only fitsKTypes field
    const { fitsKTypes: _fits, ...detail } = a;
    void _fits;
    return detail;
  }

  /**
   * OE number or article id → equivalents (§10.1 "Find Best Alternative"):
   * articles that share at least one OE number, excluding the query article.
   */
  async crossReferences(articleOrOe: string | number): Promise<ArticleRef[]> {
    let oeSet: Set<string>;
    let excludeId: number | null = null;
    if (typeof articleOrOe === 'number') {
      const a = ARTICLES.find((x) => x.articleId === articleOrOe);
      if (!a) return [];
      oeSet = new Set(a.oeNumbers.map(norm));
      excludeId = a.articleId;
    } else {
      oeSet = new Set([norm(articleOrOe)]);
    }
    return ARTICLES.filter(
      (a) => a.articleId !== excludeId && a.oeNumbers.some((n) => oeSet.has(norm(n))),
    ).map(toRef);
  }
}
