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
}
