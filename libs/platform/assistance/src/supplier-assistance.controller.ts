import { Body, Controller, Inject, Param, Patch } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ForbiddenError, ValidationError } from '@justgo/kernel';
import { ASSISTANCE_PORT, type AssistancePort } from './contract/assistance.port';
import type { AssistanceRequestDTO } from './contract/dto';

const actionSchema = z.object({ action: z.enum(['accept', 'en_route', 'complete']) }).strict();

/**
 * Supplier dispatch endpoints (§15 supplier). Dispatch MATCHING (who is
 * offered a job) is a §21 seam; here a PROVIDES_DISPATCH supplier claims and
 * advances a job it has been offered.
 */
@Controller('supplier/assistance')
export class SupplierAssistanceController {
  constructor(@Inject(ASSISTANCE_PORT) private readonly assistance: AssistancePort) {}

  @Patch(':id')
  @RequirePermissions('reservation.manage')
  async act(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AssistanceRequestDTO> {
    if (!auth.supplierScope) {
      throw new ForbiddenError('This endpoint requires a supplier-scoped token');
    }
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid action', { issues: parsed.error.issues });
    const sid = auth.supplierScope.supplierId;
    switch (parsed.data.action) {
      case 'accept':
        return this.assistance.accept(sid, id);
      case 'en_route':
        return this.assistance.advance(sid, id, 'en_route');
      case 'complete':
        return this.assistance.advance(sid, id, 'completed');
    }
  }
}
