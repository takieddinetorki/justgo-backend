/**
 * Who a bare account id actually IS, across a module boundary.
 *
 * A seam of the same kind as `SellerIdentityPort` (§21.1). Reservations,
 * orders and documents all hold a `clientAccountId` and none of them may
 * read the identity schema (§17.4), so without this the only thing a
 * supplier-facing payload can say about its customer is a UUID — which
 * is exactly what the booking card ended up printing: "Client ·
 * 4ab5bb55". A workshop cannot greet, phone, or look up a customer by
 * the first eight characters of a primary key.
 *
 * Deliberately NARROW. It answers "what do I call this person, and how
 * do I reach them", and nothing else: no email, no date of birth, no
 * address. Those belong to the account holder, and a booking is not a
 * reason to hand them over.
 */
export interface PartyDTO {
  accountId: string;
  /**
   * Given and family name joined, or null when the account has neither.
   *
   * NULL IS A REAL ANSWER and callers must render it as one. Most
   * accounts on this deployment have no name at all: nothing in the
   * signup flow ever asked for one, so inventing a label here ("Client
   * 4ab5bb55") would only move the same lie closer to the database.
   */
  name: string | null;
  /** Contact number, when the account has given one. */
  phone: string | null;
}

export interface PartyDirectoryPort {
  partyFor(accountId: string): Promise<PartyDTO | null>;
}

export const PARTY_DIRECTORY_PORT = Symbol('PARTY_DIRECTORY_PORT');
