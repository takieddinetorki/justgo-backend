import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { IDENTITY_PORT } from './contract/identity.port';
import { IdentityService, IDENTITY_REPOSITORY } from './application/identity.service';
import { PgIdentityRepository } from './infra/pg-identity.repository';
import { IdentityController } from './identity.controller';
import { SessionController } from './session.controller';
import {
  SessionService,
  SESSION_TTL_SECONDS,
  DEFAULT_SESSION_TTL_SECONDS,
} from './application/session.service';
import { SupplierRoleReactor } from './application/supplier-role.reactor';

/**
 * Owns the `identity` schema. The module keeps its own Pool so it stays
 * extract-ready (§4.8) — lifting it to a service is a wiring change only.
 */
@Module({
  controllers: [IdentityController, SessionController],
  providers: [
    {
      provide: IDENTITY_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the identity module');
        return new PgIdentityRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: IDENTITY_PORT, useClass: IdentityService },
    IdentityService,
    {
      provide: SESSION_TTL_SECONDS,
      useFactory: () => {
        const raw = process.env['SESSION_TOKEN_TTL_SECONDS'];
        const parsed = raw ? Number.parseInt(raw, 10) : NaN;
        return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_SECONDS;
      },
    },
    SessionService,
    SupplierRoleReactor,
  ],
  exports: [IDENTITY_PORT],
})
export class IdentityModule {}
