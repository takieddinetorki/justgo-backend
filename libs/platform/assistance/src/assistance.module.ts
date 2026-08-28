import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { ASSISTANCE_PORT } from './contract/assistance.port';
import { AssistanceService, ASSISTANCE_REPOSITORY } from './application/assistance.service';
import { PgAssistanceRepository } from './infra/pg-assistance.repository';
import { AssistanceController } from './assistance.controller';
import { SupplierAssistanceController } from './supplier-assistance.controller';

/** Owns the `assistance` schema — roadside dispatch requests (§7). */
@Module({
  controllers: [AssistanceController, SupplierAssistanceController],
  providers: [
    {
      provide: ASSISTANCE_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the assistance module');
        return new PgAssistanceRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: ASSISTANCE_PORT, useClass: AssistanceService },
    AssistanceService,
  ],
  exports: [ASSISTANCE_PORT],
})
export class AssistanceModule {}
