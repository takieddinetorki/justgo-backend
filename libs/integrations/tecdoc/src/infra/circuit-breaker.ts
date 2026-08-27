/**
 * Minimal circuit breaker for the TecDoc calls (§10.5): after enough
 * consecutive failures the circuit OPENS and calls short-circuit for a
 * cooldown, then a single HALF_OPEN probe decides whether to close again.
 * This is the "top third-party risk" guard — a TecDoc outage must never
 * cascade into blocked requests.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** consecutive failures before opening (default 5). */
  failureThreshold?: number;
  /** ms the circuit stays open before a probe (default 15_000). */
  cooldownMs?: number;
  /** wall clock, injectable for tests. */
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit is open');
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  current(): BreakerState {
    return this.state;
  }

  /** Runs fn through the breaker; throws CircuitOpenError while open. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) throw new CircuitOpenError();
      this.state = 'half_open';
    }
    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
