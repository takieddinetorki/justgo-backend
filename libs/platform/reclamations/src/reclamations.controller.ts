import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, hasPermission, RequirePermissions, type AuthContext } from '@justgo/auth';
import { Throttle } from '@nestjs/throttler';
import { asId, NotFoundError, ValidationError, type Uuid } from '@justgo/kernel';
import { RECLAMATIONS_PORT, type CaseActor, type ReclamationsPort } from './contract/reclamations.port';
import type { CaseDTO, CaseMessageDTO, CasePage } from './contract/dto';

const fileSchema = z
  .object({
    category: z.enum([
      'not_delivered',
      'wrong_part',
      'damaged',
      'quality',
      'overcharged',
      'no_show',
      'behaviour',
      'other',
    ]),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(5000),
    respondentSupplierId: z.string().uuid().optional(),
    subjectType: z.enum(['order', 'reservation', 'assistance', 'listing', 'quote']).optional(),
    subjectId: z.string().uuid().optional(),
    attachments: z
      .array(z.object({ bucket: z.string().max(64), path: z.string().min(1).max(300) }).strict())
      .max(10)
      .optional(),
  })
  .strict();

const messageSchema = z
  .object({ body: z.string().min(1).max(5000), internal: z.boolean().optional() })
  .strict();

const statusSchema = z
  .object({
    status: z.enum(['under_review', 'resolved', 'rejected', 'withdrawn']),
    resolution: z.string().max(2000).optional(),
  })
  .strict();

const listSchema = z.object({
  status: z.enum(['open', 'under_review', 'resolved', 'rejected', 'withdrawn']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().max(400).optional(),
});

/** Complaints and claims (§15 client + supplier + ops). */
@Controller('reclamations')
export class ReclamationsController {
  constructor(@Inject(RECLAMATIONS_PORT) private readonly cases: ReclamationsPort) {}

  /**
   * The actor, from the token alone.
   *
   * `isOps` comes from the permission, not from a role name: gating on
   * "is an admin" would break the moment a second staff role exists, and the
   * permission is the thing that is actually granted.
   */
  private actorFrom(auth: AuthContext): CaseActor {
    return {
      accountId: auth.accountId,
      supplierId: auth.supplierScope?.supplierId,
      isOps: hasPermission(auth, 'platform.admin'),
    };
  }

  /*
    Each filing burns a reference out of the sequence and lands in a
    business queue, so a loop here is both noise for them and a hole in
    our own numbering.
  */
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post()
  @HttpCode(201)
  @RequirePermissions('reclamation.file')
  async file(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<CaseDTO> {
    const parsed = fileSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid complaint', { issues: parsed.error.issues });
    }
    return this.cases.file(auth.accountId, parsed.data);
  }

  /**
   * The cases the caller may see.
   *
   * One endpoint for three audiences on purpose: a claimant sees their own, a
   * supplier-scoped token sees those against its business, and ops see
   * everything. Separate routes would mean the client has to know which kind
   * of user it is holding, which it already gets wrong elsewhere.
   */
  @Get()
  @RequirePermissions('reclamation.file')
  async list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<CasePage> {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query', { issues: parsed.error.issues });
    }
    return this.cases.list(this.actorFrom(auth), parsed.data);
  }

  @Get(':id')
  @RequirePermissions('reclamation.file')
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<CaseDTO> {
    const found = await this.cases.get(this.actorFrom(auth), asId<Uuid>(id));
    // 404, not 403: a complaint you are not party to must be
    // indistinguishable from one that does not exist.
    if (!found) throw new NotFoundError('Case', id);
    return found;
  }

  @Get(':id/messages')
  @RequirePermissions('reclamation.file')
  async messages(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ items: CaseMessageDTO[] }> {
    return { items: await this.cases.listMessages(this.actorFrom(auth), asId<Uuid>(id)) };
  }

  @Post(':id/messages')
  @HttpCode(201)
  @RequirePermissions('reclamation.file')
  async postMessage(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CaseMessageDTO> {
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid message', { issues: parsed.error.issues });
    }
    return this.cases.postMessage(this.actorFrom(auth), asId<Uuid>(id), parsed.data);
  }

  /**
   * Move the case.
   *
   * Gated on `reclamation.file` rather than `reclamation.respond`, because
   * **the claimant withdrawing their own complaint goes through here too**
   * and a claimant never holds `respond`. Which transitions each side may
   * actually take is decided in the service, where the case is in hand: a
   * decorator cannot tell a withdrawal from a dismissal.
   */
  @Patch(':id')
  @RequirePermissions('reclamation.file')
  async changeStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CaseDTO> {
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid status change', { issues: parsed.error.issues });
    }
    return this.cases.changeStatus(
      this.actorFrom(auth),
      asId<Uuid>(id),
      parsed.data.status,
      parsed.data.resolution,
    );
  }
}
