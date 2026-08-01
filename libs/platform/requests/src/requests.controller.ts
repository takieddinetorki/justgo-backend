import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import {
  asId,
  ValidationError,
  type AccountId,
  type QuoteId,
  type RequestId,
  type SupplierId,
  type VehicleId,
} from '@justgo/kernel';
import { REQUESTS_PORT, type RequestsPort } from './contract/requests.port';
import type { PartRequestDetailDTO } from './contract/dto';

const submitSchema = z
  .object({
    vehicleId: z.string().uuid().optional(),
    tecdocArticleId: z.number().int().positive().optional(),
    categoryKey: z.string().max(64).optional(),
    freeText: z.string().max(2000).optional(),
    photoUrl: z.string().url().optional(),
    quantity: z.number().int().positive().max(999).optional(),
    strategy: z.enum(['all', 'single']),
    targetSupplierId: z.string().uuid().optional(),
    expiresInMinutes: z.number().int().positive().max(60 * 24 * 14).optional(),
  })
  .strict();

const refuseSchema = z.object({ reason: z.string().max(500).optional() }).strict();

/** Client-side core loop endpoints (§15). */
@Controller()
export class RequestsController {
  constructor(@Inject(REQUESTS_PORT) private readonly requests: RequestsPort) {}

  @Post('requests')
  @RequirePermissions('request.create')
  async submit(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PartRequestDetailDTO> {
    const parsed = submitSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid part request', { issues: parsed.error.issues });
    }
    const { vehicleId, targetSupplierId, ...rest } = parsed.data;
    return this.requests.submit(auth.accountId, {
      ...rest,
      vehicleId: vehicleId ? asId<VehicleId>(vehicleId) : undefined,
      targetSupplierId: targetSupplierId ? asId<SupplierId>(targetSupplierId) : undefined,
      idempotencyKey,
    });
  }

  @Get('requests')
  @RequirePermissions('request.read')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: PartRequestDetailDTO[] }> {
    const items = await this.requests.listForClient(auth.accountId, limit ? Number(limit) : 50);
    return { items };
  }

  @Get('requests/:id')
  @RequirePermissions('request.read')
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<PartRequestDetailDTO> {
    return this.requests.getForClient(auth.accountId, asId<RequestId>(id));
  }

  @Delete('requests/:id')
  @RequirePermissions('request.cancel')
  async cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<PartRequestDetailDTO> {
    return this.requests.cancel(auth.accountId, asId<RequestId>(id));
  }

  @Post('quotes/:id/accept')
  @RequirePermissions('quote.accept')
  async accept(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<PartRequestDetailDTO> {
    return this.requests.acceptQuote(auth.accountId, asId<QuoteId>(id));
  }

  @Post('quotes/:id/refuse')
  @RequirePermissions('quote.refuse')
  async refuse(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PartRequestDetailDTO> {
    const parsed = refuseSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid refusal', { issues: parsed.error.issues });
    }
    return this.requests.refuseQuote(auth.accountId, asId<QuoteId>(id), parsed.data.reason);
  }
}

/** Exported for the supplier controller's account typing. */
export type { AccountId };
