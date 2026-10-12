import { Inject, Injectable, Optional } from '@nestjs/common';
import { NotFoundError } from '@justgo/kernel';
import { Capability, SupplierVertical, VERTICAL } from './verticals';

export class UnknownVerticalError extends NotFoundError {
  constructor(key: string) {
    super('Vertical', key);
  }
}

export class DuplicateVerticalError extends Error {
  constructor(key: string) {
    super(`Vertical key registered twice: ${key}`);
  }
}

/**
 * The registry the core queries instead of naming verticals (§9).
 * Verticals self-register via the VERTICAL multi-provider token.
 */
@Injectable()
export class VerticalRegistry {
  private readonly byKeyMap: Map<string, SupplierVertical>;

  constructor(@Optional() @Inject(VERTICAL) all: SupplierVertical[] | null) {
    this.byKeyMap = new Map();
    for (const v of all ?? []) {
      if (this.byKeyMap.has(v.key)) throw new DuplicateVerticalError(v.key);
      this.byKeyMap.set(v.key, v);
    }
  }

  all(): SupplierVertical[] {
    /*
      `Array.from`, NOT `[...map.values()]`.

      The apps are webpack+SWC bundles, and SWC's loose downlevel rewrites
      that spread as `[].concat(iterator)` — which appends the MapIterator
      OBJECT instead of iterating it. `all()` then returned a one-element
      array holding an iterator, so every `v.key` was undefined and every
      `v.capabilities` was undefined too.

      The damage was total and silent: fan-out threw "Cannot read
      properties of undefined (reading 'includes')" on every part request,
      so no supplier was ever targeted, and supplier registration rejected
      valid verticals with `UNKNOWN_VERTICAL {"known":[null]}`. Both looked
      like unrelated application bugs.

      Third occurrence of this rewrite in this codebase — see
      BullMqEventBus and messaging's attachment allow-list. The rule is
      absolute: never spread a Set, a Map, or one of their iterators.
    */
    return Array.from(this.byKeyMap.values());
  }

  withCapability(capability: Capability): SupplierVertical[] {
    return this.all().filter((v) => v.capabilities.includes(capability));
  }

  byKey(key: string): SupplierVertical {
    const v = this.byKeyMap.get(key);
    if (!v) throw new UnknownVerticalError(key);
    return v;
  }

  has(key: string): boolean {
    return this.byKeyMap.has(key);
  }
}

/**
 * Contract check (§9): every declared capability must be backed by the
 * hook it implies. Called by the per-vertical contract tests.
 */
export function assertVerticalSatisfiesCapabilities(v: SupplierVertical): void {
  const required: [Capability, keyof SupplierVertical][] = [
    ['RECEIVES_PART_REQUESTS', 'quoteFor'],
    ['LISTS_PRODUCTS', 'catalogueSpec'],
    ['LISTS_VEHICLES', 'catalogueSpec'],
    ['OFFERS_BOOKABLE_SERVICES', 'serviceSpec'],
    ['PROVIDES_DISPATCH', 'dispatchSpec'],
  ];
  const missing = required
    .filter(([cap, hook]) => v.capabilities.includes(cap) && typeof v[hook] !== 'function')
    .map(([cap, hook]) => `${cap} requires ${String(hook)}()`);
  if (missing.length > 0) {
    throw new Error(`Vertical "${v.key}" violates its capability contract: ${missing.join('; ')}`);
  }
}
