import { Injectable } from '@nestjs/common';
import type { MediaPort, SignedUpload } from '../contract/media.port';

export interface StorageHttp {
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
  /** Raw byte upload. The JSON `post` above cannot carry a PDF. */
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Raw byte download, for re-hashing a stored object. */
  get(path: string): Promise<Uint8Array>;
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
    if (!res.ok) {
      /*
        Include the body. Storage explains a 400 there, and throwing only
        the status cost an hour of guessing at exactly such a failure.
      */
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Supabase Storage ${path} -> HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`,
      );
    }
    return (await res.json()) as T;
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.supabaseUrl.replace(/\/$/, '')}/storage/v1/${path}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        authorization: `Bearer ${this.opts.serviceKey}`,
        apikey: this.opts.serviceKey,
        // Refuse to overwrite. Sealed documents are write-once: a path
        // that already exists means something has gone badly wrong, and
        // silently replacing it would destroy evidence.
        'x-upsert': 'false',
      },
      body: Buffer.from(bytes),
    });
    if (!res.ok) throw new Error(`Supabase Storage PUT ${path} -> HTTP ${res.status}`);
  }

  async get(path: string): Promise<Uint8Array> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.supabaseUrl.replace(/\/$/, '')}/storage/v1/${path}`, {
      headers: {
        authorization: `Bearer ${this.opts.serviceKey}`,
        apikey: this.opts.serviceKey,
      },
    });
    if (!res.ok) throw new Error(`Supabase Storage GET ${path} -> HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
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

  /*
    One POST signs the whole list. Note the shape difference from the
    single-object call: the bucket is the LAST path segment and the object
    paths go in the body, so `object/sign/post-media` with two paths is a
    batch while `object/sign/post-media/a/b.png` is one object. Getting
    that backwards signs an object literally named after the bucket.
  */
  async createSignedDownloadUrls(input: {
    bucket: string;
    paths: string[];
    expiresInSeconds?: number;
  }): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    /*
      NO SPREAD OF A SET. `[...new Set(xs)]` is the obvious way to write
      this and it is broken in the shipped bundle: SWC's loose
      downlevelling turns it into `[].concat(set)`, which appends the Set
      OBJECT rather than its members. Storage then receives
      `{"paths":[{}]}` and answers 400 — only in the webpack build, never
      in a unit test. That is now the FIFTH defect in this codebase from
      this one transform; `social.service.ts` carries the same warning
      over its allow-list.
    */
    const paths = input.paths.filter((path, i) => input.paths.indexOf(path) === i);
    if (paths.length === 0) return out;
    /*
      Say what is wrong HERE rather than letting Storage answer 400 about
      it. The failure above sent object-shaped entries and all we learned
      was the status code; this names the problem at the boundary where it
      can still be read.
    */
    const bad = paths.find((path) => typeof path !== 'string' || path.length === 0);
    if (bad !== undefined) {
      throw new TypeError(`createSignedDownloadUrls got a non-string path: ${JSON.stringify(bad)}`);
    }
    const res = await this.http.post<
      { error: string | null; path: string | null; signedURL: string }[]
    >(`object/sign/${input.bucket}`, {
      expiresIn: input.expiresInSeconds ?? this.defaultTtl,
      paths,
    });
    res.forEach((row) => {
      // Storage reports a per-path failure in the row, not as an HTTP error.
      if (row.error || !row.path || !row.signedURL) return;
      out.set(row.path, `${this.baseUrl}/storage/v1/${row.signedURL.replace(/^\//, '')}`);
    });
    return out;
  }

  async putObject(input: {
    bucket: string;
    path: string;
    bytes: Uint8Array;
    contentType?: string;
  }): Promise<void> {
    await this.http.put(
      `object/${input.bucket}/${input.path}`,
      input.bytes,
      input.contentType ?? 'application/octet-stream',
    );
  }

  async getObject(input: { bucket: string; path: string }): Promise<Uint8Array> {
    return this.http.get(`object/${input.bucket}/${input.path}`);
  }
}
