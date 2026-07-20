import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { IDENTITY_PORT } from './contract/identity.port';
import { IdentityService, IDENTITY_REPOSITORY } from './application/identity.service';
import { PgIdentityRepository } from './infra/pg-identity.repository';
import { IdentityController } from './identity.controller';

/**
 * Owns the `identity` schema. The module keeps its own Pool so it stays
 * extract-ready (§4.8) — lifting it to a service is a wiring change only.
 */
@Module({
  controllers: [IdentityController],
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
  ],
  exports: [IDENTITY_PORT],
})
export class IdentityModule {}
