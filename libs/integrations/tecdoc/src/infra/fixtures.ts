import type {
  ArticleDetail,
  AssemblyGroup,
  VehicleTypeRef,
} from '@justgo/contracts';

const L = (en: string, es: string, fr: string) => ({ en, es, fr });

/**
 * Fixture data standing in for the TecDoc Catalogue API in Phase 1 (§19).
 * Deliberately small — this is NOT a copy of TecDoc (§10.4); it exists only
 * so the browse/quote flows work before the real adapter lands in Phase 2.
 * The shapes match CataloguePort exactly, so swapping in the live adapter
 * touches only this integration.
 */
export const ASSEMBLY_GROUPS: AssemblyGroup[] = [
  { id: 100, key: 'engine', label: L('Engine', 'Motor', 'Moteur'), parentId: null },
  { id: 200, key: 'braking', label: L('Braking system', 'Sistema de frenos', 'Système de freinage'), parentId: null },
  { id: 300, key: 'suspension', label: L('Suspension', 'Suspensión', 'Suspension'), parentId: null },
  { id: 400, key: 'steering', label: L('Steering', 'Dirección', 'Direction'), parentId: null },
  { id: 500, key: 'electrics', label: L('Electrics', 'Sistema eléctrico', 'Système électrique'), parentId: null },
  { id: 600, key: 'filters', label: L('Filters', 'Filtros', 'Filtres'), parentId: null },
  { id: 700, key: 'body', label: L('Body', 'Carrocería', 'Carrosserie'), parentId: null },
  { id: 800, key: 'exhaust', label: L('Exhaust', 'Escape', 'Échappement'), parentId: null },
  { id: 900, key: 'cooling', label: L('Cooling', 'Refrigeración', 'Refroidissement'), parentId: null },
  { id: 1000, key: 'transmission', label: L('Transmission', 'Transmisión', 'Transmission'), parentId: null },
];

export const VEHICLES: VehicleTypeRef[] = [
  {
    kType: 19087,
    manufacturerId: 121,
    modelId: 8506,
    manufacturer: 'VOLKSWAGEN',
    model: 'GOLF VII (5G1, BQ1, BE1, BE2)',
    typeName: '1.6 TDI',
    fromYear: 2012,
    toYear: 2020,
    powerKw: 77,
    fuel: 'Diesel',
  },
  {
    kType: 11504,
    manufacturerId: 121,
    modelId: 8506,
    manufacturer: 'VOLKSWAGEN',
    model: 'GOLF VII (5G1, BQ1, BE1, BE2)',
    typeName: '1.4 TSI',
    fromYear: 2012,
    toYear: 2020,
    powerKw: 90,
    fuel: 'Petrol',
  },
  {
    kType: 34290,
    manufacturerId: 84,
    modelId: 5312,
    manufacturer: 'RENAULT',
    model: 'CLIO IV (BH_)',
    typeName: '1.5 dCi 90',
    fromYear: 2012,
    toYear: null,
    powerKw: 66,
    fuel: 'Diesel',
  },
  {
    kType: 40120,
    manufacturerId: 74,
    modelId: 4021,
    manufacturer: 'PEUGEOT',
    model: '208 I (CA_, CC_)',
    typeName: '1.6 HDi',
    fromYear: 2012,
    toYear: 2019,
    powerKw: 68,
    fuel: 'Diesel',
  },
];

/** Which assembly groups exist for a given KType (all of them, for fixtures). */
export const GROUPS_BY_KTYPE: Record<number, number[]> = {
  19087: [100, 200, 300, 400, 500, 600, 800, 900, 1000],
  11504: [100, 200, 300, 400, 500, 600, 800, 900, 1000],
  34290: [100, 200, 300, 500, 600, 800, 900],
  40120: [100, 200, 300, 500, 600, 800, 900],
};

export interface FixtureArticle extends ArticleDetail {
  /** KTypes this article fits (for search-by-vehicle). */
  fitsKTypes: number[];
}

const img = (id: number) => `https://tecdoc.example/img/${id}.jpg`;

export const ARTICLES: FixtureArticle[] = [
  {
    articleId: 1001,
    name: 'Brake Pad Set, disc brake',
    brand: 'BOSCH',
    reference: '0 986 494 600',
    assemblyGroupId: 200,
    fitsKTypes: [19087, 11504],
    attributes: [
      { key: 'position', label: L('Fitting position', 'Posición', 'Position'), value: 'Front Axle' },
      { key: 'width_mm', label: L('Width [mm]', 'Ancho [mm]', 'Largeur [mm]'), value: '155.1' },
      { key: 'height_mm', label: L('Height [mm]', 'Altura [mm]', 'Hauteur [mm]'), value: '58.5' },
    ],
    images: [img(1001)],
    oeNumbers: ['5Q0698151', '5Q0698151A'],
  },
  {
    articleId: 1002,
    name: 'Brake Pad Set, disc brake',
    brand: 'BREMBO',
    reference: 'P 85 147',
    assemblyGroupId: 200,
    fitsKTypes: [19087, 11504],
    attributes: [
      { key: 'position', label: L('Fitting position', 'Posición', 'Position'), value: 'Front Axle' },
    ],
    images: [img(1002)],
    oeNumbers: ['5Q0698151', '5Q0698151A'],
  },
  {
    articleId: 1003,
    name: 'Brake Disc',
    brand: 'ATE',
    reference: '24.0125-0201.1',
    assemblyGroupId: 200,
    fitsKTypes: [19087, 11504],
    attributes: [
      { key: 'diameter_mm', label: L('Diameter [mm]', 'Diámetro [mm]', 'Diamètre [mm]'), value: '288' },
    ],
    images: [img(1003)],
    oeNumbers: ['5Q0615301F'],
  },
  {
    articleId: 2001,
    name: 'Oil Filter',
    brand: 'MANN-FILTER',
    reference: 'HU 719/7 x',
    assemblyGroupId: 600,
    fitsKTypes: [19087, 34290, 40120],
    attributes: [
      { key: 'type', label: L('Filter type', 'Tipo de filtro', 'Type de filtre'), value: 'Filter Insert' },
    ],
    images: [img(2001)],
    oeNumbers: ['03L115562'],
  },
  {
    articleId: 3001,
    name: 'Air Filter',
    brand: 'MAHLE',
    reference: 'LX 1780',
    assemblyGroupId: 600,
    fitsKTypes: [19087, 11504],
    attributes: [],
    images: [img(3001)],
    oeNumbers: ['5Q0129620D'],
  },
  {
    articleId: 4001,
    name: 'Shock Absorber',
    brand: 'SACHS',
    reference: '314 875',
    assemblyGroupId: 300,
    fitsKTypes: [19087, 11504],
    attributes: [
      { key: 'position', label: L('Fitting position', 'Posición', 'Position'), value: 'Front Axle' },
    ],
    images: [img(4001)],
    oeNumbers: ['5Q0413031'],
  },
];
