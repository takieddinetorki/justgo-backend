import { Body, Controller, Delete, Get, Inject, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ValidationError, type Uuid } from '@justgo/kernel';
import type { AccountDTO } from './contract/dto';
import { IDENTITY_PORT, type IdentityPort } from './contract/identity.port';

/**
 * Images are (bucket, path), never URLs (§14), and the bucket is fixed:
 * an avatar is a pointer into a private bucket, and letting a client name
 * the bucket would make this a pointer into ANY of them.
 */
const avatarSchema = z
  .object({
    bucket: z.literal('avatars'),
    path: z.string().min(1).max(300),
  })
  .strict();

/** `null` clears a field; absent leaves it alone. */
const profilePatchSchema = z
  .object({
    firstName: z.string().max(120).optional(),
    familyName: z.string().max(120).optional(),
    phone: z.string().max(32).nullable().optional(),
    email: z.string().email().max(200).nullable().optional(),
    dob: z.string().date().nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    country: z.string().length(2).nullable().optional(),
    avatar: avatarSchema.nullable().optional(),
    locale: z.enum(['en', 'es', 'fr']).optional(),
  })
  .strict();

/**
 * /v1/me (§15). The controller only parses (zod) and delegates (§17.1).
 *
 * Every route here goes through `currentAccount`, never `ensureAccount`.
 * `AuthContext.accountId` is an identity account id for a session token and
 * a Supabase auth user id for a raw GoTrue one, and `ensureAccount` keys on
 * the latter alone — so it used to insert a ghost account whenever the
 * caller held a session token, which is every call the apps make after the
 * exchange. `currentAccount` resolves either id first and self-provisions
 * only on genuine first contact.
 */
@Controller('me')
export class IdentityController {
  constructor(@Inject(IDENTITY_PORT) private readonly identity: IdentityPort) {}

  @Get()
  @RequirePermissions()
  async me(@CurrentAuth() auth: AuthContext): Promise<AccountDTO> {
    return this.identity.currentAccount(auth.accountId as unknown as Uuid, {
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
    const account = await this.identity.currentAccount(auth.accountId as unknown as Uuid, {
      locale: auth.locale,
    });

    /*
      An uploaded object must live under the caller's own namespace — the
      same rule the driver document flow applies. `POST /v1/media/uploads`
      prefixes every path with the account id, so a path that does not start
      with one of the caller's own ids was not issued to them.

      Both ids are accepted because both circulate as "the account id": a
      token minted before session issuance existed carries the Supabase
      `sub`, and media paths signed under it are still the caller's own.
    */
    const avatar = parsed.data.avatar;
    if (
      avatar &&
      !avatar.path.startsWith(`${auth.accountId}/`) &&
      !avatar.path.startsWith(`${account.id}/`) &&
      !avatar.path.startsWith(`${account.authUserId}/`)
    ) {
      throw new ValidationError('Avatar path must be within your own upload namespace');
    }

    return this.identity.updateProfile(account.id, parsed.data);
  }

  /**
   * `DELETE /v1/me` — close this account.
   *
   * ANONYMISATION, NOT DELETION, and the difference is deliberate. The name,
   * email, phone, date of birth, city and avatar are blanked and every role
   * is dropped, so the person disappears from the feed, from messages and
   * from reviews, and the next sign-in reaches nothing. The row stays,
   * because orders, reservations and reclamations belong to the other party
   * as much as to this one.
   *
   * **Invoices and the other sealed documents keep the name they were issued
   * under.** They render from a snapshot taken at issue, signed over their
   * exact bytes, under a number in a gapless fiscal series — a tax document
   * is not ours to rewrite, and editing the bytes would break the signature
   * that proves nobody has.
   *
   * Refused with 422 `ACCOUNT_OWNS_BUSINESS` while this account still acts
   * for a supplier: close the business first.
   *
   * Idempotent, and irreversible. A session token already issued keeps
   * working until it expires — permissions are baked into it at exchange —
   * so an app that closes an account should drop its token immediately.
   */
  @Delete()
  @RequirePermissions()
  async close(@CurrentAuth() auth: AuthContext): Promise<AccountDTO> {
    const account = await this.identity.currentAccount(auth.accountId as unknown as Uuid, {
      locale: auth.locale,
    });
    return this.identity.closeAccount(account.id);
  }
}
