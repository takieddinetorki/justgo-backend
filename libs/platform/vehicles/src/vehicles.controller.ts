import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ValidationError, type VehicleId } from '@justgo/kernel';
import { VEHICLES_PORT, type VehiclesPort } from './contract/vehicles.port';
import type { HealthEntryDTO, MaintenanceTaskDTO, VehicleDTO } from './contract/dto';

const addSchema = z
  .object({
    name: z.string().max(120).optional(),
    brand: z.string().max(80).optional(),
    model: z.string().max(80).optional(),
    year: z.number().int().min(1900).max(2100).optional(),
    vin: z.string().max(32).optional(),
    plate: z.string().max(16).optional(),
    mileageKm: z.number().int().nonnegative().optional(),
    photoUrl: z.string().url().optional(),
    resolveTecDoc: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().max(120).optional(),
    plate: z.string().max(16).optional(),
    photoUrl: z.string().url().optional(),
    healthStatus: z.enum(['optimal', 'good', 'warning', 'critical', 'urgent']).optional(),
  })
  .strict();

const mileageSchema = z.object({ mileageKm: z.number().int().nonnegative() }).strict();

const taskSchema = z
  .object({
    title: z.string().min(1).max(200),
    intervalKm: z.number().int().positive().optional(),
    intervalMonths: z.number().int().positive().optional(),
    dueAtKm: z.number().int().positive().optional(),
    dueDate: z.string().date().optional(),
  })
  .strict();

/** Client garage endpoints (§15 client — garage). */
@Controller('vehicles')
export class VehiclesController {
  constructor(@Inject(VEHICLES_PORT) private readonly vehicles: VehiclesPort) {}

  @Get()
  @RequirePermissions('vehicle.manage')
  async list(@CurrentAuth() auth: AuthContext): Promise<{ items: VehicleDTO[] }> {
    return { items: await this.vehicles.list(auth.accountId) };
  }

  @Post()
  @RequirePermissions('vehicle.manage')
  async add(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<VehicleDTO> {
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid vehicle', { issues: parsed.error.issues });
    return this.vehicles.add(auth.accountId, parsed.data);
  }

  @Get(':id')
  @RequirePermissions('vehicle.manage')
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<VehicleDTO> {
    return this.vehicles.get(auth.accountId, asId<VehicleId>(id));
  }

  @Patch(':id')
  @RequirePermissions('vehicle.manage')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VehicleDTO> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid update', { issues: parsed.error.issues });
    return this.vehicles.update(auth.accountId, asId<VehicleId>(id), parsed.data);
  }

  @Delete(':id')
  @RequirePermissions('vehicle.manage')
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<{ deleted: true }> {
    await this.vehicles.remove(auth.accountId, asId<VehicleId>(id));
    return { deleted: true };
  }

  @Patch(':id/mileage')
  @RequirePermissions('vehicle.manage')
  async mileage(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VehicleDTO> {
    const parsed = mileageSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid mileage', { issues: parsed.error.issues });
    return this.vehicles.setMileage(auth.accountId, asId<VehicleId>(id), parsed.data.mileageKm);
  }

  @Get(':id/health')
  @RequirePermissions('vehicle.manage')
  async health(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ items: HealthEntryDTO[] }> {
    return { items: await this.vehicles.listHealth(auth.accountId, asId<VehicleId>(id)) };
  }

  @Get(':id/maintenance')
  @RequirePermissions('vehicle.manage')
  async maintenance(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ items: MaintenanceTaskDTO[] }> {
    return { items: await this.vehicles.listMaintenance(auth.accountId, asId<VehicleId>(id)) };
  }

  @Post(':id/maintenance')
  @RequirePermissions('vehicle.manage')
  async addMaintenance(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MaintenanceTaskDTO> {
    const parsed = taskSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid task', { issues: parsed.error.issues });
    return this.vehicles.addMaintenanceTask(auth.accountId, asId<VehicleId>(id), parsed.data);
  }
}
