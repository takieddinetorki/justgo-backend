import { Injectable } from '@nestjs/common';
import type { MediaPort, SignedUpload } from '../contract/media.port';

export interface StorageHttp {
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
}

export interface SupabaseStorageOptions {
  supabaseUrl: string;
  serviceKey: string;
  defaultDownloadTtl?: number;
  fetchImpl?: typeof fetch;
}

/** fetch-based Supabase Storage REST client (injectable transport for tests). */
export class SupabaseStorageHttp implements StorageHttp {
  constructor(private readonly opts: SupabaseStorageOptions) {}

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.supabaseUrl.replace(/\/$/, '')}/storage/v1/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.serviceKey}`,
        apikey: this.opts.serviceKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase Storage ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

/**
 * Supabase Storage adapter (§14). Signed uploads via the storage REST API;
 * short-lived signed downloads for private buckets. The API never proxies
 * bytes — clients talk to storage directly with the returned URL.
 */
@Injectable()
export class SupabaseStorageAdapter implements MediaPort {
  private readonly baseUrl: string;
  private readonly defaultTtl: number;

  constructor(
    private readonly http: StorageHttp,
    baseUrl: string,
    defaultDownloadTtl = 3600,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultTtl = defaultDownloadTtl;
  }

  async createUploadUrl(input: { bucket: string; path: string }): Promise<SignedUpload> {
    const res = await this.http.post<{ url?: string; token: string }>(
      `object/upload/sign/${input.bucket}/${input.path}`,
      {},
    );
    const relative = res.url ?? `object/upload/sign/${input.bucket}/${input.path}?token=${res.token}`;
    return {
      uploadUrl: `${this.baseUrl}/storage/v1/${relative.replace(/^\//, '')}`,
      path: input.path,
      token: res.token,
      expiresInSeconds: 7200,
    };
  }

  async createSignedDownloadUrl(input: {
    bucket: string;
    path: string;
    expiresInSeconds?: number;
  }): Promise<string> {
    const ttl = input.expiresInSeconds ?? this.defaultTtl;
    const res = await this.http.post<{ signedURL: string }>(
      `object/sign/${input.bucket}/${input.path}`,
      { expiresIn: ttl },
    );
    return `${this.baseUrl}/storage/v1/${res.signedURL.replace(/^\//, '')}`;
  }
}
