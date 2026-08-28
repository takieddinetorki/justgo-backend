import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ValidationError, type VehicleId } from '@justgo/kernel';
import { ASSISTANCE_PORT, type AssistancePort } from './contract/assistance.port';
import type { AssistanceRequestDTO } from './contract/dto';

const createSchema = z
  .object({
    serviceType: z.enum(['breakdown', 'tow', 'battery', 'tyre', 'fuel', 'lockout']),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    vehicleId: z.string().uuid().optional(),
    description: z.string().max(1000).optional(),
    pickupAddress: z.string().max(300).optional(),
  })
  .strict();

/** Client roadside-assistance endpoints (§15 client — fulfilment). */
@Controller('assistance')
export class AssistanceController {
  constructor(@Inject(ASSISTANCE_PORT) private readonly assistance: AssistancePort) {}

  @Post()
  @RequirePermissions('reservation.create')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<AssistanceRequestDTO> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid assistance request', { issues: parsed.error.issues });
    }
    const { vehicleId, ...rest } = parsed.data;
    return this.assistance.request(auth.accountId, {
      ...rest,
      vehicleId: vehicleId ? asId<VehicleId>(vehicleId) : undefined,
    });
  }

  @Get()
  @RequirePermissions('reservation.create')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: AssistanceRequestDTO[] }> {
    return { items: await this.assistance.listForClient(auth.accountId, limit ? Number(limit) : 50) };
  }

  @Delete(':id')
  @RequirePermissions('reservation.create')
  async cancel(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<AssistanceRequestDTO> {
    return this.assistance.cancel(auth.accountId, id);
  }
}
