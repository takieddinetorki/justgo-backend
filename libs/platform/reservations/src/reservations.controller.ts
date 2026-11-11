import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CurrentAuth,
  MileageUpToDateGuard,
  RequirePermissions,
  type AuthContext,
} from '@justgo/auth';
import { asId, ValidationError, type BranchId, type ReservationId, type SupplierId, type VehicleId } from '@justgo/kernel';
import { RESERVATIONS_PORT, type ReservationsPort } from './contract/reservations.port';
import type { ReservationDTO } from './contract/dto';

const createSchema = z
  .object({
    supplierId: z.string().uuid(),
    branchId: z.string().uuid().optional(),
    serviceTypeKey: z.string().min(1).max(64),
    vehicleId: z.string().uuid().optional(),
    slotStart: z.string().datetime(),
    slotEnd: z.string().datetime(),
    note: z.string().max(500).optional(),
  })
  .strict();

/** Client reservation endpoints (§15 client — fulfilment). */
@Controller('reservations')
export class ReservationsController {
  constructor(@Inject(RESERVATIONS_PORT) private readonly reservations: ReservationsPort) {}

  @Post()
  @RequirePermissions('reservation.create')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ReservationDTO> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid reservation', { issues: parsed.error.issues });
    const { supplierId, branchId, vehicleId, ...rest } = parsed.data;
    return this.reservations.request(auth.accountId, {
      ...rest,
      supplierId: asId<SupplierId>(supplierId),
      branchId: branchId ? asId<BranchId>(branchId) : undefined,
      vehicleId: vehicleId ? asId<VehicleId>(vehicleId) : undefined,
    });
  }

  /*
    Behind the mileage lock (§ mileage): this list is what the client
    app turns into notifications, so a stale odometer has to stop it at
    the server and not only on the screen. A supplier-scoped caller is
    reading its own work queue, not its notifications - but the lock is
    computed from the CALLER's own vehicles, and a business account has
    none, so it is never locked by this. Nothing extra to special-case.
  */
  @Get()
  @RequirePermissions('reservation.create')
  @UseGuards(MileageUpToDateGuard)
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: ReservationDTO[] }> {
    return { items: await this.reservations.listForClient(auth.accountId, limit ? Number(limit) : 50) };
  }

  @Delete(':id')
  @RequirePermissions('reservation.create')
  async cancel(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<ReservationDTO> {
    return this.reservations.cancel(auth.accountId, asId<ReservationId>(id));
  }
}
