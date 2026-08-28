// PUBLIC surface: the module wiring only (§5). The adapter, transport,
// circuit breaker, cache and resilience decorator are private infra —
// TecDocModule.forRoot() composes them; nothing else imports them.
export { TecDocModule, type TecDocModuleOptions } from './tecdoc.module';
