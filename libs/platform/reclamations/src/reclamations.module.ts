import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { RECLAMATIONS_PORT } from './contract/reclamations.port';
import { ReclamationsService, RECLAMATIONS_REPOSITORY } from './application/reclamations.service';
import { PgReclamationsRepository } from './infra/pg-reclamations.repository';
import { ReclamationsController } from './reclamations.controller';

/** Owns the `reclamations` schema. Extract-ready: its own Pool (§4.8). */
@Module({
  controllers: [ReclamationsController],
  providers: [
    {
      provide: RECLAMATIONS_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the reclamations module');
        return new PgReclamationsRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: RECLAMATIONS_PORT, useClass: ReclamationsService },
    ReclamationsService,
  ],
  exports: [RECLAMATIONS_PORT],
})
export class ReclamationsModule {}
