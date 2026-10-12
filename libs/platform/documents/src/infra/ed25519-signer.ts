import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { DocumentSigner, SealedDocument } from '../contract/signer.port';

export interface Ed25519SignerOptions {
  /** PKCS#8 PEM. From the secret manager — never the repo, never the DB. */
  privateKeyPem: string;
  /** Recorded on every document so keys can rotate without invalidating any. */
  keyId: string;
  /**
   * Public keys of RETIRED key ids, so documents sealed before a rotation
   * stay verifiable forever. Without this, rotating a key silently
   * invalidates history — which is the one thing this system must never
   * do.
   */
  retiredPublicKeys?: Array<{ keyId: string; publicKeyPem: string }>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Detached Ed25519 over the SHA-256 of the stored bytes.
 *
 * Ed25519 because it is small, fast, has no parameter choices to get
 * wrong, and needs no certificate authority. It proves *we* issued these
 * exact bytes — which is the whole requirement until a qualified AECE
 * seal is in place for fiscal documents.
 *
 * Signing the HASH rather than the file keeps the operation constant-time
 * in document size, and means verification can be done by anyone holding
 * the file and the published public key.
 */
export class Ed25519DocumentSigner implements DocumentSigner {
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly publicKeyPem: string;
  private readonly retired: Map<string, string>;

  constructor(private readonly opts: Ed25519SignerOptions) {
    this.privateKey = createPrivateKey(opts.privateKeyPem);
    this.publicKeyPem = createPublicKey(this.privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    this.retired = new Map(
      (opts.retiredPublicKeys ?? []).map((k) => [k.keyId, k.publicKeyPem]),
    );
  }

  async seal(pdf: Uint8Array): Promise<SealedDocument> {
    const digest = Buffer.from(sha256Hex(pdf), 'hex');
    // Ed25519 takes the message directly — `null` algorithm is required.
    const signature = sign(null, digest, this.privateKey);
    return {
      // Unchanged: the signature is detached. A PAdES adapter would return
      // different bytes here and they would become the stored artefact.
      bytes: pdf,
      signature: signature.toString('base64'),
      format: 'detached',
      algo: 'ed25519',
      keyId: this.opts.keyId,
    };
  }

  async verify(input: {
    bytes: Uint8Array;
    signature: string | null;
    keyId: string;
    algo: string;
  }): Promise<boolean> {
    if (!input.signature || input.algo !== 'ed25519') return false;

    const pem =
      input.keyId === this.opts.keyId
        ? this.publicKeyPem
        : this.retired.get(input.keyId);
    // An unknown key id means we cannot prove anything — which is "not
    // verified", never "verified".
    if (!pem) return false;

    try {
      const digest = Buffer.from(sha256Hex(input.bytes), 'hex');
      return verify(
        null,
        digest,
        createPublicKey(pem),
        Buffer.from(input.signature, 'base64'),
      );
    } catch {
      // A malformed signature is a failed verification, not a crash.
      return false;
    }
  }

  publicKeys(): Array<{ keyId: string; algo: string; publicKey: string }> {
    return [
      { keyId: this.opts.keyId, algo: 'ed25519', publicKey: this.publicKeyPem },
      ...Array.from(this.retired.entries()).map(([keyId, publicKey]) => ({
        keyId,
        algo: 'ed25519',
        publicKey,
      })),
    ];
  }
}
