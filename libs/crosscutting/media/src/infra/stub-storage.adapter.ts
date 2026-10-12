import { Injectable } from '@nestjs/common';
import type { MediaPort, SignedUpload } from '../contract/media.port';

/** No-Supabase fallback for dev/CI — returns deterministic local URLs. */
@Injectable()
export class StubStorageAdapter implements MediaPort {
  async createUploadUrl(input: { bucket: string; path: string }): Promise<SignedUpload> {
    return {
      uploadUrl: `http://localhost:0/upload/${input.bucket}/${input.path}?token=stub`,
      path: input.path,
      token: 'stub',
      expiresInSeconds: 7200,
    };
  }

  async createSignedDownloadUrl(input: { bucket: string; path: string }): Promise<string> {
    return `http://localhost:0/download/${input.bucket}/${input.path}?token=stub`;
  }

  /*
    An in-memory store, not a no-op. Document issuance writes bytes and
    verification reads them back; a stub that silently dropped them would
    make every verification fail for a reason unrelated to the signature.
  */
  private readonly objects = new Map<string, Uint8Array>();

  async putObject(input: {
    bucket: string;
    path: string;
    bytes: Uint8Array;
  }): Promise<void> {
    this.objects.set(`${input.bucket}/${input.path}`, input.bytes);
  }

  async getObject(input: { bucket: string; path: string }): Promise<Uint8Array> {
    const found = this.objects.get(`${input.bucket}/${input.path}`);
    if (!found) throw new Error(`Stub storage has no object at ${input.bucket}/${input.path}`);
    return found;
  }
}
