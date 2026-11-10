import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ForbiddenError, ValidationError, type ReservationId } from '@justgo/kernel';
import { RESERVATIONS_PORT, type ReservationsPort } from './contract/reservations.port';
import type { ReservationDTO, SupplierReservationDTO } from './contract/dto';

const actionSchema = z
  .object({
    action: z.enum(['accept', 'reject', 'reschedule', 'complete']),
    reason: z.string().max(500).optional(),
    slotStart: z.string().datetime().optional(),
    slotEnd: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => v.action !== 'reschedule' || (v.slotStart && v.slotEnd), {
    message: 'reschedule requires slotStart and slotEnd',
  });

/** Supplier calendar endpoints (§15 supplier — calendar). */
@Controller('supplier/reservations')
export class SupplierReservationsController {
  constructor(@Inject(RESERVATIONS_PORT) private readonly reservations: ReservationsPort) {}

  private scope(auth: AuthContext) {
    if (!auth.supplierScope) throw new ForbiddenError('This endpoint requires a supplier-scoped token');
    return auth.supplierScope.supplierId;
  }

  @Get()
  @RequirePermissions('reservation.manage')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: SupplierReservationDTO[] }> {
    return { items: await this.reservations.listForSupplier(this.scope(auth), limit ? Number(limit) : 50) };
  }

  /**
   * One booking, by id. WHERE A SCANNED CONFIRMATION LANDS.
   *
   * The QR resolves to a document, the document names its subject, and
   * the app comes straight here with that id. Before this route existed
   * the scan could prove a confirmation was genuine and then had
   * nowhere to go, so the app fell back to listing the whole calendar
   * and asking the person to pick the booking out of it by hand.
   */
  @Get(':id')
  @RequirePermissions('reservation.manage')
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<SupplierReservationDTO> {
    return this.reservations.getForSupplier(this.scope(auth), asId<ReservationId>(id));
  }

  @Patch(':id')
  @RequirePermissions('reservation.manage')
  async act(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReservationDTO> {
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid reservation action', { issues: parsed.error.issues });
    const supplierId = this.scope(auth);
    const rid = asId<ReservationId>(id);
    switch (parsed.data.action) {
      case 'accept':
        return this.reservations.accept(supplierId, rid);
      case 'reject':
        return this.reservations.reject(supplierId, rid, parsed.data.reason);
      case 'reschedule':
        return this.reservations.reschedule(supplierId, rid, {
          slotStart: parsed.data.slotStart as string,
          slotEnd: parsed.data.slotEnd as string,
        });
      case 'complete':
        return this.reservations.complete(supplierId, rid);
    }
  }
}
