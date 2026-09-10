import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import type { Uuid } from '@justgo/kernel';
import { SUPPLIER_OWNER_ROLE } from '../contract/roles';
import { PgIdentityRepository } from '../infra/pg-identity.repository';
import { IDENTITY_REPOSITORY } from './identity.service';

/** suppliers.SupplierRegistered — consumed by name, not by importing suppliers. */
const SUPPLIER_REGISTERED = 'suppliers.SupplierRegistered';

interface SupplierRegisteredPayload {
  supplierId: string;
  ownerAccountId: string;
}

/**
 * Turns "this account registered a business" into "this account may act
 * for that business".
 *
 * Without it, supplier scope existed only in `suppliers.suppliers.
 * owner_account_id` — a column in another module's schema that identity
 * may not read (§17.4). So there was no way to mint a supplier-scoped
 * token except by hand, which is exactly the gap this work closes. The
 * assignment lands in `identity.user_roles` where session issuance can
 * see it.
 *
 * Idempotent: `assignRole` is an `on conflict do nothing` insert, so
 * at-least-once redelivery is safe.
 */
@Injectable()
export class SupplierRoleReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplierRoleReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(IDENTITY_REPOSITORY) private readonly repo: PgIdentityRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(SUPPLIER_REGISTERED, (e) => this.handle(e));
  }

  async handle(event: DomainEvent): Promise<void> {
    const { supplierId, ownerAccountId } = event.payload as unknown as SupplierRegisteredPayload;
    if (!supplierId || !ownerAccountId) return;

    /*
      `ownerAccountId` is whatever the registering token put in
      AuthContext.accountId. Before session issuance that was the Supabase
      `sub`, not `identity.accounts.id` — and user_roles.account_id has a
      foreign key to the latter, so inserting the raw value would throw.
      Resolving through both columns makes old and new tokens converge on
      the same account.
    */
    const account = await this.repo.findByIdOrAuthUserId(ownerAccountId as Uuid);
    if (!account) {
      this.logger.warn(
        `SupplierRegistered ${supplierId}: no account for owner ${ownerAccountId}; supplier scope not granted`,
      );
      return;
    }

    await this.repo.assignRole(account.id, SUPPLIER_OWNER_ROLE, {
      type: 'supplier',
      id: supplierId as Uuid,
    });
    this.logger.log(`granted ${SUPPLIER_OWNER_ROLE} on ${supplierId} to account ${account.id}`);
  }
}
