import { generateKeyPairSync } from 'node:crypto';
import { Ed25519DocumentSigner, sha256Hex } from './ed25519-signer';

function newKey(): { pem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('Ed25519DocumentSigner', () => {
  const key = newKey();
  const signer = new Ed25519DocumentSigner({ privateKeyPem: key.pem, keyId: 'k1' });
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);

  it('seals and verifies its own output', async () => {
    const sealed = await signer.seal(bytes);
    expect(sealed.format).toBe('detached');
    expect(sealed.algo).toBe('ed25519');
    expect(sealed.keyId).toBe('k1');
    // Detached: the bytes are handed back untouched and stay canonical.
    expect(Array.from(sealed.bytes)).toEqual(Array.from(bytes));

    await expect(
      signer.verify({ bytes, signature: sealed.signature, keyId: 'k1', algo: 'ed25519' }),
    ).resolves.toBe(true);
  });

  /*
    The property the whole system rests on: one altered byte and the seal
    fails. If this ever passes on modified input, every guarantee in the
    document subsystem is void.
  */
  it('rejects a single flipped byte', async () => {
    const sealed = await signer.seal(bytes);
    const tampered = Uint8Array.from(bytes);
    tampered[3] = (tampered[3] ?? 0) ^ 0x01;

    await expect(
      signer.verify({ bytes: tampered, signature: sealed.signature, keyId: 'k1', algo: 'ed25519' }),
    ).resolves.toBe(false);
  });

  it('rejects a signature made by a different key', async () => {
    const other = new Ed25519DocumentSigner({ privateKeyPem: newKey().pem, keyId: 'k1' });
    const forged = await other.seal(bytes);

    // Same key id, different key — the id is a label, not proof.
    await expect(
      signer.verify({ bytes, signature: forged.signature, keyId: 'k1', algo: 'ed25519' }),
    ).resolves.toBe(false);
  });

  it('refuses an unknown key id rather than assuming the current one', async () => {
    const sealed = await signer.seal(bytes);
    await expect(
      signer.verify({ bytes, signature: sealed.signature, keyId: 'retired-2019', algo: 'ed25519' }),
    ).resolves.toBe(false);
  });

  it('still verifies documents sealed by a retired key', async () => {
    const old = newKey();
    const oldSigner = new Ed25519DocumentSigner({ privateKeyPem: old.pem, keyId: 'k0' });
    const sealed = await oldSigner.seal(bytes);

    // Rotating a key must never invalidate history.
    const rotated = new Ed25519DocumentSigner({
      privateKeyPem: key.pem,
      keyId: 'k1',
      retiredPublicKeys: [{ keyId: 'k0', publicKeyPem: old.publicPem }],
    });
    await expect(
      rotated.verify({ bytes, signature: sealed.signature, keyId: 'k0', algo: 'ed25519' }),
    ).resolves.toBe(true);
    expect(rotated.publicKeys().map((k) => k.keyId).sort()).toEqual(['k0', 'k1']);
  });

  it('treats a missing or malformed signature as unverified, not as an error', async () => {
    await expect(
      signer.verify({ bytes, signature: null, keyId: 'k1', algo: 'ed25519' }),
    ).resolves.toBe(false);
    await expect(
      signer.verify({ bytes, signature: 'not-base64-$$$', keyId: 'k1', algo: 'ed25519' }),
    ).resolves.toBe(false);
  });

  it('refuses an algorithm it does not implement', async () => {
    const sealed = await signer.seal(bytes);
    await expect(
      signer.verify({ bytes, signature: sealed.signature, keyId: 'k1', algo: 'RSA-SHA256' }),
    ).resolves.toBe(false);
  });

  it('publishes a public key, never the private one', () => {
    const keys = signer.publicKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(keys[0]?.publicKey).not.toContain('PRIVATE');
  });

  it('hashes deterministically and differs on any change', () => {
    expect(sha256Hex(bytes)).toBe(sha256Hex(Uint8Array.from(bytes)));
    expect(sha256Hex(bytes)).not.toBe(sha256Hex(new Uint8Array([...bytes, 9])));
  });
});
