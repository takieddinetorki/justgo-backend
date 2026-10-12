import { SupabaseStorageAdapter, type StorageHttp } from './infra/supabase-storage.adapter';
import { StubOcrProvider } from './infra/stub-ocr.provider';

describe('SupabaseStorageAdapter (§14)', () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  // Byte store for put/get — sealed documents are written and read back
  // through this transport, so a no-op would hide a real break.
  const objects = new Map<string, Uint8Array>();
  const http: StorageHttp = {
    post: async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      calls.push({ path, body });
      if (path.startsWith('object/upload/sign/')) return { token: 'tok123' } as T;
      return { signedURL: `object/sign/registrations/x?token=dl` } as T;
    },
    put: async (path: string, bytes: Uint8Array): Promise<void> => {
      objects.set(path, bytes);
    },
    get: async (path: string): Promise<Uint8Array> => {
      const found = objects.get(path);
      if (!found) throw new Error(`no object at ${path}`);
      return found;
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

  it('round-trips raw bytes through put/get', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await adapter.putObject({ bucket: 'documents', path: 'a/b.pdf', bytes, contentType: 'application/pdf' });
    const back = await adapter.getObject({ bucket: 'documents', path: 'a/b.pdf' });
    expect(Array.from(back)).toEqual([1, 2, 3, 4, 5]);
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
