import axios, { AxiosError } from 'axios';

describe('GET /v1/health', () => {
  it('returns ok', async () => {
    const res = await axios.get(`/v1/health`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
    expect(res.data.service).toBe('justgo-api');
  });
});

describe('error envelope (§17.3)', () => {
  it('unknown routes return the standard envelope with a stable code', async () => {
    const err = await axios.get(`/v1/definitely-not-a-route`).catch((e: AxiosError) => e);
    expect(err).toBeInstanceOf(AxiosError);
    const response = (err as AxiosError).response!;
    expect(response.status).toBe(404);
    expect(response.data).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('OpenAPI (§15 contract of record)', () => {
  it('serves a valid OpenAPI 3 document at /v1/docs-json', async () => {
    const res = await axios.get(`/v1/docs-json`);
    expect(res.status).toBe(200);
    expect(res.data.openapi).toMatch(/^3\./);
    expect(res.data.info.title).toBe('JustGo Backend API');
    // bearer security scheme + core paths are present
    expect(res.data.components.securitySchemes).toHaveProperty('supabase-jwt');
    expect(Object.keys(res.data.paths)).toEqual(
      expect.arrayContaining(['/v1/requests', '/v1/me', '/v1/catalogue/articles']),
    );
  });
});
