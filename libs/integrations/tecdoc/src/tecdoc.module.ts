import { Module, type DynamicModule } from '@nestjs/common';
import { CATALOGUE_PORT } from '@justgo/contracts';
import { StubTecDocAdapter } from './infra/stub-tecdoc.adapter';

/**
 * The TecDoc anti-corruption module (§10): the ONLY thing that talks to
 * TecDoc. Phase 1 wires the fixture stub; Phase 2 adds the real REST adapter
 * behind a circuit breaker + Redis short-TTL cache and selects it here — no
 * consumer of CATALOGUE_PORT changes.
 */
@Module({})
export class TecDocModule {
  static forRoot(): DynamicModule {
    return {
      module: TecDocModule,
      global: true,
      providers: [{ provide: CATALOGUE_PORT, useClass: StubTecDocAdapter }],
      exports: [CATALOGUE_PORT],
    };
  }
}
