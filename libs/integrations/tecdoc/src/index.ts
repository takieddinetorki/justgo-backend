// PUBLIC surface: the module + resilience building blocks used at composition.
export { TecDocModule, type TecDocModuleOptions } from './tecdoc.module';
export { CircuitBreaker, CircuitOpenError, type BreakerState } from './infra/circuit-breaker';
export {
  FetchHttpTransport,
  TecDocHttpError,
  type HttpTransport,
  type TecDocHttpRequest,
} from './infra/http-transport';
export { HttpTecDocAdapter } from './infra/http-tecdoc.adapter';
export {
  ResilientCatalogue,
  type ResilientCatalogueOptions,
} from './infra/resilient-catalogue';
export {
  InMemoryCatalogueCache,
  RedisCatalogueCache,
  type CatalogueCache,
} from './infra/catalogue-cache';
