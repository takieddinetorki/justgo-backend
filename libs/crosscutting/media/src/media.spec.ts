import { SupabaseStorageAdapter, type StorageHttp } from './infra/supabase-storage.adapter';
import { StubOcrProvider } from './infra/stub-ocr.provider';

describe('SupabaseStorageAdapter (§14)', () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const http: StorageHttp = {
    post: async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      calls.push({ path, body });
      if (path.startsWith('object/upload/sign/')) return { token: 'tok123' } as T;
      return { signedURL: `object/sign/registrations/x?token=dl` } as T;
    },
  };
  const adapter = new SupabaseStorageAdapter(http, 'https://sb.example');

  it('builds a pre-signed upload URL from the token', async () => {
    const up = await adapter.createUploadUrl({ bucket: 'registrations', path: 'acc/1_reg.jpg' });
    expect(up.token).toBe('tok123');
    expect(up.path).toBe('acc/1_reg.jpg');
    expect(up.uploadUrl).toContain('https://sb.example/storage/v1/object/upload/sign/registrations/acc/1_reg.jpg');
  });

  it('builds a short-lived signed download URL', async () => {
    const url = await adapter.createSignedDownloadUrl({ bucket: 'registrations', path: 'acc/1_reg.jpg', expiresInSeconds: 120 });
    expect(url).toContain('https://sb.example/storage/v1/object/sign/registrations/x?token=dl');
    expect(calls.at(-1)?.body).toEqual({ expiresIn: 120 });
  });
});

describe('StubOcrProvider (§14)', () => {
  it('derives a low-confidence draft that the client must confirm', async () => {
    const ocr = new StubOcrProvider();
    const draft = await ocr.scanRegistration({ bucket: 'registrations', path: 'acc/Renault_Clio_2015_AB123CD.jpg' });
    expect(draft).toMatchObject({ brand: 'Renault', model: 'Clio', year: 2015, plate: 'AB123CD' });
    expect(draft.confidence).toBeLessThan(1); // never trusted outright
  });
});
