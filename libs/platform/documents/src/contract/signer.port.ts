/**
 * The seal applied to a rendered document.
 *
 * WHY A PORT. Today this is Ed25519 over a SHA-256 of the PDF: our own
 * key, detached signature, good enough to prove we issued these exact
 * bytes. Algerian fiscal documents will eventually need a QUALIFIED
 * signature from AECE, and the shape of that is genuinely different —
 * per their published services, THI9A certificates live on a FIPS 140-2
 * device and there is no documented remote signing API. A qualified
 * provider is therefore likely to hand back a MODIFIED PDF with the
 * signature embedded (PAdES) rather than a detached blob.
 *
 * So the contract is deliberately written around that: a signer returns
 * the bytes that are to be STORED. If it embeds, those bytes differ from
 * what went in and they become canonical; if it detaches, they are
 * returned unchanged alongside a signature. Either way the caller hashes
 * and stores whatever comes back, so swapping the adapter is a new file
 * rather than a migration of history.
 */
export interface SealedDocument {
  /** The bytes to store. Identical to the input for a detached signature. */
  bytes: Uint8Array;
  /** Base64 detached signature. Null when the signature is embedded. */
  signature: string | null;
  format: 'detached' | 'embedded';
  /** e.g. 'ed25519', later 'RSA-SHA256' or the AECE certificate's algorithm. */
  algo: string;
  /**
   * Which key signed it. Recorded per document so keys rotate without
   * invalidating anything already issued.
   */
  keyId: string;
}

export interface DocumentSigner {
  seal(pdf: Uint8Array): Promise<SealedDocument>;
  /**
   * Verifies a detached signature against bytes. Embedded-signature
   * adapters verify by parsing the PDF instead and may ignore
   * `signature`.
   */
  verify(input: {
    bytes: Uint8Array;
    signature: string | null;
    keyId: string;
    algo: string;
  }): Promise<boolean>;
  /**
   * Public keys, by id, for independent offline verification.
   *
   * Published deliberately. If a document can only be verified by asking
   * our API whether it is valid, the signature proves nothing to a
   * sceptical third party — they are trusting us, not the maths.
   */
  publicKeys(): Array<{ keyId: string; algo: string; publicKey: string }>;
}

export const DOCUMENT_SIGNER = Symbol('DOCUMENT_SIGNER');
