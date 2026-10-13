import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS, type DomainEvent, type EventBus } from '@justgo/events';
import type { Uuid } from '@justgo/kernel';
import { DRIVER_ROLE } from '../contract/roles';
import { PgIdentityRepository } from '../infra/pg-identity.repository';
import { IDENTITY_REPOSITORY } from './identity.service';

/** drivers.* — consumed by name, not by importing drivers. */
const DRIVER_VERIFIED = 'drivers.DriverVerified';
const DRIVER_REFUSED = 'drivers.DriverRefused';

interface VerifiedPayload {
  driverId: string;
  accountId: string;
}

interface RefusedPayload {
  driverId: string;
  accountId: string;
  status: 'rejected' | 'suspended';
}

/**
 * Turns "this person passed a licence check" into "this person may drive".
 *
 * WHY A REACTOR AND NOT A ROLE AT SIGNUP. `driver.work` is the bit that lets
 * someone go online and be dispatched to a stranded motorist. It is the
 * outcome of somebody looking at a licence photo and a selfie, so it cannot
 * be handed out when an account is created — and it has to come back off
 * when the verification stops holding, which is what the refused branch does.
 *
 * Suspension revokes; rejection has nothing to revoke but is handled on the
 * same path so a rejected driver who was somehow granted the role loses it.
 *
 * Idempotent on both sides: `assignRole` is an `on conflict do nothing`
 * insert and the delete is a no-op when the row is already gone, so
 * at-least-once redelivery is safe.
 */
@Injectable()
export class DriverRoleReactor implements OnApplicationBootstrap {
  private readonly logger = new Logger(DriverRoleReactor.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(IDENTITY_REPOSITORY) private readonly repo: PgIdentityRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe(DRIVER_VERIFIED, (e) => this.grant(e));
    await this.bus.subscribe(DRIVER_REFUSED, (e) => this.revoke(e));
  }

  async grant(event: DomainEvent): Promise<void> {
    const { driverId, accountId } = event.payload as unknown as VerifiedPayload;
    if (!accountId) return;

    const account = await this.repo.findByIdOrAuthUserId(accountId as Uuid);
    if (!account) {
      this.logger.warn(`DriverVerified ${driverId}: no account for ${accountId}; role not granted`);
      return;
    }
    await this.repo.assignRole(account.id, DRIVER_ROLE, undefined);
    this.logger.log(`granted ${DRIVER_ROLE} to account ${account.id} (driver ${driverId})`);
  }

  async revoke(event: DomainEvent): Promise<void> {
    const { driverId, accountId, status } = event.payload as unknown as RefusedPayload;
    if (!accountId) return;

    const account = await this.repo.findByIdOrAuthUserId(accountId as Uuid);
    if (!account) {
      this.logger.warn(`DriverRefused ${driverId}: no account for ${accountId}; nothing revoked`);
      return;
    }
    await this.repo.revokeGlobalRole(account.id, DRIVER_ROLE);
    this.logger.log(
      `revoked ${DRIVER_ROLE} from account ${account.id} (driver ${driverId}, ${status})`,
    );
  }
}
