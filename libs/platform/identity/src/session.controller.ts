import { Body, Controller, Headers, Post } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermissions } from '@justgo/auth';
import { UnauthenticatedError, ValidationError } from '@justgo/kernel';
import type { SessionDTO } from './contract/dto';
import { SessionService } from './application/session.service';

const sessionSchema = z
  .object({
    supplierId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    scope: z.enum(['client', 'supplier']).optional(),
  })
  .strict()
  .refine((v) => !(v.branchId && !v.supplierId), {
    message: 'branchId requires supplierId',
  });

/**
 * `POST /v1/auth/session` — exchange a GoTrue access token for a JustGo
 * session token.
 *
 * `@RequirePermissions()` with no arguments on purpose: the caller arrives
 * holding a GoTrue token, which by definition carries no permissions yet.
 * Requiring one here would make the endpoint that fixes the permission
 * problem unreachable without already having solved it. Authentication is
 * still enforced — `RbacGuard` verifies the bearer token before this
 * handler runs.
 */
@Controller('auth')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Post('session')
  @RequirePermissions()
  async createSession(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<SessionDTO> {
    const parsed = sessionSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid session request', { issues: parsed.error.issues });
    }
    /*
      The guard already proved this header exists and verifies; we need the
      raw string because the session is minted FROM the caller's claims,
      not from the projection the guard kept.
    */
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthenticatedError('Missing bearer token');
    }
    return this.sessions.issue(authorization.slice('Bearer '.length), parsed.data);
  }
}
