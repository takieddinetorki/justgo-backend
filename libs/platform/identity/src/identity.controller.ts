import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ValidationError, type Uuid } from '@justgo/kernel';
import type { AccountDTO } from './contract/dto';
import { IDENTITY_PORT, type IdentityPort } from './contract/identity.port';

const profilePatchSchema = z
  .object({
    firstName: z.string().max(120).optional(),
    familyName: z.string().max(120).optional(),
    phone: z.string().max(32).optional(),
    locale: z.enum(['en', 'es', 'fr']).optional(),
  })
  .strict();

/**
 * /v1/me (§15). The controller only parses (zod) and delegates (§17.1).
 * ensureAccount makes first contact self-provisioning: a fresh Supabase
 * user gets an account row + default role on their first call.
 */
@Controller('me')
export class IdentityController {
  constructor(@Inject(IDENTITY_PORT) private readonly identity: IdentityPort) {}

  @Get()
  @RequirePermissions()
  async me(@CurrentAuth() auth: AuthContext): Promise<AccountDTO> {
    return this.identity.ensureAccount(auth.accountId as unknown as Uuid, {
      locale: auth.locale,
    });
  }

  @Put()
  @RequirePermissions()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<AccountDTO> {
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid profile patch', { issues: parsed.error.issues });
    }
    const account = await this.identity.ensureAccount(auth.accountId as unknown as Uuid, {
      locale: auth.locale,
    });
    return this.identity.updateProfile(account.id, parsed.data);
  }
}
