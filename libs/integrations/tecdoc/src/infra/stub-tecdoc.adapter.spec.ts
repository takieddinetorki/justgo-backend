import { StubTecDocAdapter } from './stub-tecdoc.adapter';

describe('StubTecDocAdapter (CataloguePort fixtures)', () => {
  const adapter = new StubTecDocAdapter();

  it('resolves a vehicle to KType candidates by manufacturer/model/year', async () => {
    const golf = await adapter.resolveVehicle({ manufacturer: 'volkswagen', model: 'golf', year: 2015 });
    expect(golf.length).toBeGreaterThan(0);
    expect(golf.every((v) => v.kType > 0)).toBe(true);
    expect(golf.map((v) => v.kType)).toContain(19087);
  });

  it('filters vehicles out of the year range', async () => {
    const tooOld = await adapter.resolveVehicle({ manufacturer: 'volkswagen', year: 2005 });
    expect(tooOld).toEqual([]);
  });

  it('lists assembly groups for a KType, empty for unknown', async () => {
    const groups = await adapter.assemblyGroups(19087);
    expect(groups.map((g) => g.key)).toEqual(expect.arrayContaining(['braking', 'filters']));
    expect(groups[0].label).toHaveProperty('fr'); // trilingual labels
    expect(await adapter.assemblyGroups(999999)).toEqual([]);
  });

  it('searches articles by KType + assembly group', async () => {
    const brakes = await adapter.searchArticles({ kType: 19087, assemblyGroupId: 200 });
    expect(brakes.length).toBeGreaterThanOrEqual(2);
    expect(brakes.every((a) => a.assemblyGroupId === 200)).toBe(true);
  });

  it('searches by OE number and free text', async () => {
    const byOe = await adapter.searchArticles({ oe: '5Q0698151' });
    expect(byOe.map((a) => a.brand)).toEqual(expect.arrayContaining(['BOSCH', 'BREMBO']));
    const byText = await adapter.searchArticles({ text: 'mann' });
    expect(byText[0].brand).toBe('MANN-FILTER');
  });

  it('returns article detail with attributes/images/OE, null for unknown', async () => {
    const detail = await adapter.articleDetail(1001);
    expect(detail?.reference).toBe('0 986 494 600');
    expect(detail?.oeNumbers).toContain('5Q0698151');
    expect(detail).not.toHaveProperty('fitsKTypes'); // fixture-only field stripped
    expect(await adapter.articleDetail(123456)).toBeNull();
  });

  it('finds cross-references sharing an OE, excluding the query article', async () => {
    const alts = await adapter.crossReferences(1001);
    expect(alts.map((a) => a.articleId)).toContain(1002); // shares 5Q0698151
    expect(alts.map((a) => a.articleId)).not.toContain(1001);

    const byOe = await adapter.crossReferences('5Q0698151');
    expect(byOe.map((a) => a.articleId)).toEqual(expect.arrayContaining([1001, 1002]));
  });
});
