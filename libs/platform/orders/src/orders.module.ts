import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { ORDERS_PORT } from './contract/orders.port';
import { OrdersService, ORDERS_REPOSITORY } from './application/orders.service';
import { OrderFromQuoteReactor } from './application/order-from-quote.reactor';
import { PgOrdersRepository } from './infra/pg-orders.repository';
import { OrdersController } from './orders.controller';

/** Owns the `orders` schema; reacts to requests.QuoteAccepted (§12). */
@Module({
  controllers: [OrdersController],
  providers: [
    {
      provide: ORDERS_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the orders module');
        return new PgOrdersRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: ORDERS_PORT, useClass: OrdersService },
    OrdersService,
    OrderFromQuoteReactor,
  ],
  exports: [ORDERS_PORT],
})
export class OrdersModule {}
