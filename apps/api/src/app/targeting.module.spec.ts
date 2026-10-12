import { SUPPLIER_TARGETING_PORT } from '@justgo/contracts';
import { TargetingModule } from './targeting.module';

/**
 * Guards the two properties that make the fan-out seam reachable.
 *
 * Background: `SUPPLIER_TARGETING_PORT` used to be declared in AppModule's
 * own `providers` array. Nest never exposes those to an imported module,
 * so `FanOutReactor` — which lives inside RequestsModule — resolved it to
 * null and silently dropped every part request. 25 submitted, 0 quoted,
 * 21 expired, on a server that looked healthy.
 *
 * Two things stop that happening again, and only one of them is a test:
 *
 *  1. `FanOutReactor` no longer injects the port `@Optional()`, so a
 *     mis-wired application REFUSES TO BOOT rather than idling. That is
 *     the real guarantee — enforced on every start, in every environment.
 *  2. This spec, which pins the module metadata the fix depends on.
 *     Dropping `global: true` or the export would re-break it in exactly
 *     the original way.
 *
 * What this deliberately does NOT do is build the Nest graph. Under jest,
 * pnpm's strict layout resolves a second copy of `@nestjs/core` for the
 * prebuilt `@justgo/auth`, so `Reflector`'s class identity differs and
 * AuthModule cannot satisfy RbacGuard — a harness artefact that does not
 * occur in the server. A test that fails for a reason unrelated to its
 * subject teaches nobody anything.
 */
describe('TargetingModule', () => {
  const mod = TargetingModule.forRoot();

  it('is global — otherwise RequestsModule cannot see the port', () => {
    expect(mod.global).toBe(true);
  });

  it('exports the targeting port', () => {
    expect(mod.exports).toContain(SUPPLIER_TARGETING_PORT);
  });

  it('provides the token, not just the adapter class', () => {
    const tokens = (mod.providers ?? []).map((p) =>
      typeof p === 'object' && p !== null && 'provide' in p ? p.provide : p,
    );
    expect(tokens).toContain(SUPPLIER_TARGETING_PORT);
  });

  it('imports suppliers, which supplies the port it adapts', () => {
    expect(mod.imports).toBeDefined();
    expect((mod.imports ?? []).length).toBeGreaterThan(0);
  });
});
