import { Inject, Injectable } from '@nestjs/common';
import type { PartyDTO, PartyDirectoryPort } from '@justgo/contracts';
import { IDENTITY_PORT, type IdentityPort } from '@justgo/identity';
import type { AccountId } from '@justgo/kernel';

/**
 * Composition-root adapter joining the booking screens to `identity`
 * (§21.1): neither reservations nor identity depends on the other, the
 * app binds them, and either stays extractable behind a network client
 * (§4.8).
 */
@Injectable()
export class PartyDirectoryAdapter implements PartyDirectoryPort {
  constructor(@Inject(IDENTITY_PORT) private readonly identity: IdentityPort) {}

  async partyFor(accountId: string): Promise<PartyDTO | null> {
    /*
      `resolveAccount`, not `getById`. Both an identity account id and a
      Supabase auth user id circulate as "the account id" — an event
      emitted from a session minted before the exchange existed carries
      the latter — and a lookup that only knows one of them answers null
      for a person who is plainly there.
    */
    const a = await this.identity.resolveAccount(accountId as AccountId);
    if (!a) return null;
    const name = [a.firstName, a.familyName]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter((part) => part.length > 0)
      .join(' ');
    return {
      accountId: a.id,
      // Empty string is not a name. Null says "we do not know", which is
      // the truth for every account that was never asked for one.
      name: name.length > 0 ? name : null,
      phone: a.phone && a.phone.trim().length > 0 ? a.phone.trim() : null,
    };
  }
}
