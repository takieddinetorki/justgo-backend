import { NotFoundException } from '@nestjs/common';
import { ValidationError } from '@justgo/kernel';
import type {
  ArticleDetail,
  ArticleQuery,
  ArticleRef,
  AssemblyGroup,
  CataloguePort,
  VehicleQuery,
  VehicleTypeRef,
} from '@justgo/contracts';
import { CatalogueController } from './catalogue.controller';

class FakePort implements CataloguePort {
  lastArticleQuery: ArticleQuery | null = null;
  lastVehicleQuery: VehicleQuery | null = null;
  async resolveVehicle(q: VehicleQuery): Promise<VehicleTypeRef[]> {
    this.lastVehicleQuery = q;
    return [];
  }
  async assemblyGroups(kType: number): Promise<AssemblyGroup[]> {
    return kType === 19087
      ? [{ id: 200, key: 'braking', label: { en: 'B', es: 'B', fr: 'B' }, parentId: null }]
      : [];
  }
  async searchArticles(q: ArticleQuery): Promise<ArticleRef[]> {
    this.lastArticleQuery = q;
    return [{ articleId: 1, name: 'Pad', brand: 'BOSCH', reference: 'X', assemblyGroupId: 200 }];
  }
  async articleDetail(articleId: number): Promise<ArticleDetail | null> {
    return articleId === 1
      ? { articleId: 1, name: 'Pad', brand: 'BOSCH', reference: 'X', assemblyGroupId: 200, attributes: [], images: [], oeNumbers: [] }
      : null;
  }
  async crossReferences(): Promise<ArticleRef[]> {
    return [];
  }
}

describe('CatalogueController', () => {
  const setup = () => {
    const port = new FakePort();
    return { port, ctl: new CatalogueController(port) };
  };

  it('maps ?group= to assemblyGroupId when searching articles', async () => {
    const { port, ctl } = setup();
    const res = await ctl.articles({ kType: '19087', group: '200' });
    expect(res.items).toHaveLength(1);
    expect(port.lastArticleQuery).toMatchObject({ kType: 19087, assemblyGroupId: 200 });
  });

  it('requires a numeric kType for assembly-groups', async () => {
    const { ctl } = setup();
    await expect(ctl.assemblyGroups(undefined)).rejects.toThrow(ValidationError);
    await expect(ctl.assemblyGroups('abc')).rejects.toThrow(ValidationError);
    expect((await ctl.assemblyGroups('19087')).items[0].key).toBe('braking');
  });

  it('404s an unknown article, returns a known one', async () => {
    const { ctl } = setup();
    await expect(ctl.articleDetail('999')).rejects.toThrow(NotFoundException);
    expect((await ctl.articleDetail('1')).reference).toBe('X');
  });

  it('cross-refs accepts an OE or a numeric articleId, else 400', async () => {
    const { ctl } = setup();
    await expect(ctl.crossRefs(undefined, undefined)).rejects.toThrow(ValidationError);
    await expect(ctl.crossRefs('5Q0698151', undefined)).resolves.toEqual({ items: [] });
    await expect(ctl.crossRefs(undefined, '1')).resolves.toEqual({ items: [] });
  });

  it('rejects an unknown query field (strict schema)', async () => {
    const { ctl } = setup();
    await expect(ctl.articles({ bogus: 'x' })).rejects.toThrow(ValidationError);
  });
});
