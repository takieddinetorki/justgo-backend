/**
 * Thin HTTP transport for the TecDoc adapter, injectable so the adapter is
 * unit-testable without a live TecDoc (Open Question §21.2 — endpoint shape
 * and credentials are confirmed with TecAlliance before go-live). Applies a
 * hard timeout and jittered exponential backoff retry (§10.5).
 */
export interface TecDocHttpRequest {
  path: string;
  body: Record<string, unknown>;
}

export interface HttpTransport {
  post<T>(req: TecDocHttpRequest): Promise<T>;
}

export interface FetchTransportOptions {
  baseUrl: string;
  apiKey: string;
  /** TecAlliance provider id (a.k.a. TecDoc customer number). */
  providerId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TecDocHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TecDocHttpError';
  }
}

/** fetch-based transport with timeout + jittered backoff. */
export class FetchHttpTransport implements HttpTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: FetchTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  async post<T>(req: TecDocHttpRequest): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.once<T>(req);
      } catch (error) {
        lastError = error;
        // do not retry a definitive client error (4xx except 429)
        if (error instanceof TecDocHttpError && error.status < 500 && error.status !== 429) {
          throw error;
        }
        if (attempt < this.maxRetries) {
          const backoff = 2 ** attempt * 100;
          await this.sleep(backoff + Math.floor(this.random() * backoff));
        }
      }
    }
    throw lastError;
  }

  private async once<T>(req: TecDocHttpRequest): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${req.path.replace(/^\//, '')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          ...(this.opts.providerId ? { 'x-provider-id': this.opts.providerId } : {}),
        },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new TecDocHttpError(res.status, `TecDoc ${req.path} -> HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
