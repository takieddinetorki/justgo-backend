import { createHash } from 'node:crypto';

/**
 * The document's content hash — printed on the page, carried by the QR,
 * and the key the verification endpoint looks up.
 *
 * WHY NOT THE HASH OF THE PDF FILE. A document cannot contain its own
 * file hash. The hash is computed over the bytes; printing it changes
 * the bytes; the printed value is then wrong. There is no text you can
 * print that satisfies "hash of the file including this text" — finding
 * one on demand would mean breaking SHA-256. So the printed hash is
 * taken over what the document SAYS rather than over how it was laid
 * out, and the file hash stays in the registry doing its own, different
 * job: `sha256` on the row is what catches a byte edited inside the PDF,
 * when the holder uploads their copy.
 *
 * This hash is just as sensitive to content as a file hash would be. One
 * comma changed in a line description, one digit in a price, one
 * character in the buyer's name, and the digest is entirely different.
 *
 * NO TWO DOCUMENTS SHARE ONE, even two that say exactly the same thing.
 * `number` is in the pre-image and is unique per (series, year, seq)
 * from a gapless counter, so two identical invoices issued a second
 * apart still hash differently. `prevSha256` is in there too, binding
 * the digest to the document's position in its series, so a document
 * cannot be lifted out of the chain and re-presented as another. The
 * column carries a UNIQUE index as well — the claim is enforced by the
 * database rather than argued for here.
 */

/**
 * JSON with keys sorted at every level and no whitespace.
 *
 * `JSON.stringify` preserves insertion order, and the payload comes back
 * out of jsonb, which does NOT preserve it. A digest built on plain
 * `JSON.stringify` would verify when computed at issue and fail when
 * recomputed from the stored snapshot, for two objects that are equal.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface ContentHashInput {
  /** Unique per document, from the gapless series. */
  number: string;
  type: string;
  issuedAt: Date;
  /** The previous document's file hash — the chain link. */
  prevSha256: string | null;
  /** Exactly what the document was rendered from. */
  payload: Record<string, unknown>;
}

/** Lower-case 64-character hex. */
export function documentContentHash(input: ContentHashInput): string {
  const preImage = canonicalJson({
    v: 1,
    number: input.number,
    type: input.type,
    issuedAt: input.issuedAt.toISOString(),
    prevSha256: input.prevSha256,
    payload: input.payload,
  });
  return createHash('sha256').update(preImage, 'utf8').digest('hex');
}

/**
 * Accept a hash the way a person will actually give it back: pasted out
 * of the QR, or typed off the page in the groups it is printed in, in
 * either case. Returns null when it is not a hash at all, so a caller
 * can tell "that is not a code" from "no such document".
 */
export function normaliseContentHash(raw: string): string | null {
  const cleaned = raw.replace(/[\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : null;
}

/** `6b89c31d c3d56279 …` — eight groups of eight, over two lines. */
export function groupContentHash(hash: string): [string, string] {
  const groups = hash.match(/.{1,8}/g) ?? [];
  return [groups.slice(0, 4).join(' '), groups.slice(4).join(' ')];
}
