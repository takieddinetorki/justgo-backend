import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { CLOCK, SystemClock } from '@justgo/kernel';
import { QUOTES_PORT, REQUESTS_PORT } from './contract/requests.port';
import { RequestsService, REQUESTS_REPOSITORY } from './application/requests.service';
import { QuotesService } from './application/quotes.service';
import { FanOutReactor } from './application/fan-out.reactor';
import { PgRequestsRepository } from './infra/pg-requests.repository';
import { RequestsController } from './requests.controller';
import { SupplierQuotesController } from './supplier-quotes.controller';

/**
 * Owns the `requests` schema: part_requests + quotes + the §8.1 state
 * machines. The SupplierTargetingPort it fans out through is provided by
 * the composition root (shared contract, §21.1 seam).
 */
@Module({
  controllers: [RequestsController, SupplierQuotesController],
  providers: [
    {
      provide: REQUESTS_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the requests module');
        return new PgRequestsRepository(new Pool({ connectionString: url, max: 10 }));
      },
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: REQUESTS_PORT, useClass: RequestsService },
    { provide: QUOTES_PORT, useClass: QuotesService },
    RequestsService,
    QuotesService,
    FanOutReactor,
  ],
  exports: [REQUESTS_PORT, QUOTES_PORT],
})
export class RequestsModule {}
