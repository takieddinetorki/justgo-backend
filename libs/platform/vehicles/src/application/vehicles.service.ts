import { Inject, Injectable, Logger } from '@nestjs/common';
import { BusinessRuleError, type AccountId, type VehicleId } from '@justgo/kernel';
import { CATALOGUE_PORT, type CataloguePort } from '@justgo/contracts';
import type { VehiclesPort } from '../contract/vehicles.port';
import type {
  AddMaintenanceTaskDTO,
  AddVehicleDTO,
  HealthEntryDTO,
  MaintenanceTaskDTO,
  UpdateVehicleDTO,
  VehicleDTO,
} from '../contract/dto';
import { PgVehiclesRepository } from '../infra/pg-vehicles.repository';

export const VEHICLES_REPOSITORY = Symbol('VEHICLES_REPOSITORY');

@Injectable()
export class VehiclesService implements VehiclesPort {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(
    @Inject(VEHICLES_REPOSITORY) private readonly repo: PgVehiclesRepository,
    @Inject(CATALOGUE_PORT) private readonly catalogue: CataloguePort,
  ) {}

  /**
   * Resolve the KType at garage setup and store only the returned IDs (§10.1).
   * Resolution is best-effort: TecDoc being down must not block adding a car
   * (§10.5) — the resilient adapter already degrades, and we swallow the rest.
   */
  private async resolveTecDoc(
    input: AddVehicleDTO,
  ): Promise<{ manufacturerId: number | null; modelId: number | null; kType: number | null }> {
    const none = { manufacturerId: null, modelId: null, kType: null };
    if (input.resolveTecDoc === false || !input.brand) return none;
    try {
      const candidates = await this.catalogue.resolveVehicle({
        manufacturer: input.brand,
        model: input.model,
        year: input.year,
      });
      const best = candidates[0];
      return best
        ? { manufacturerId: best.manufacturerId, modelId: best.modelId, kType: best.kType }
        : none;
    } catch (error) {
      this.logger.warn(`KType resolution failed for ${input.brand} ${input.model ?? ''}: ${(error as Error).message}`);
      return none;
    }
  }

  async add(ownerAccountId: AccountId, input: AddVehicleDTO): Promise<VehicleDTO> {
    if (!input.brand && !input.name && !input.vin) {
      throw new BusinessRuleError('VEHICLE_UNDESCRIBED', 'A vehicle needs at least a name, brand, or VIN');
    }
    const tecdoc = await this.resolveTecDoc(input);
    return this.repo.insert(ownerAccountId, input, tecdoc);
  }

  list(ownerAccountId: AccountId): Promise<VehicleDTO[]> {
    return this.repo.list(ownerAccountId);
  }

  get(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<VehicleDTO> {
    return this.repo.find(ownerAccountId, vehicleId);
  }

  update(ownerAccountId: AccountId, vehicleId: VehicleId, patch: UpdateVehicleDTO): Promise<VehicleDTO> {
    return this.repo.update(ownerAccountId, vehicleId, patch);
  }

  remove(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<void> {
    return this.repo.remove(ownerAccountId, vehicleId);
  }

  setMileage(ownerAccountId: AccountId, vehicleId: VehicleId, mileageKm: number): Promise<VehicleDTO> {
    if (!Number.isInteger(mileageKm) || mileageKm < 0) {
      throw new BusinessRuleError('INVALID_MILEAGE', 'Mileage must be a non-negative integer');
    }
    return this.repo.setMileage(ownerAccountId, vehicleId, mileageKm);
  }

  async addMaintenanceTask(
    ownerAccountId: AccountId,
    vehicleId: VehicleId,
    input: AddMaintenanceTaskDTO,
  ): Promise<MaintenanceTaskDTO> {
    await this.repo.find(ownerAccountId, vehicleId); // ownership check
    return this.repo.addTask(vehicleId, input);
  }

  async listMaintenance(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<MaintenanceTaskDTO[]> {
    await this.repo.find(ownerAccountId, vehicleId);
    return this.repo.listTasks(vehicleId);
  }

  async listHealth(ownerAccountId: AccountId, vehicleId: VehicleId): Promise<HealthEntryDTO[]> {
    await this.repo.find(ownerAccountId, vehicleId);
    return this.repo.listHealth(vehicleId);
  }

  sweepDueMaintenance(now: Date = new Date()): Promise<number> {
    return this.repo.sweepDue(now);
  }
}
