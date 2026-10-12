/**
 * Media contract (§14): clients get a short-lived pre-signed URL and upload
 * directly to Supabase Storage; buckets are private and every read is served
 * through a short-lived signed URL. Nothing streams bytes through the API.
 */
export interface SignedUpload {
  /** URL the client PUTs the file bytes to. */
  uploadUrl: string;
  /** storage path of the object once uploaded (persist this, not the URL). */
  path: string;
  /** opaque token embedded in uploadUrl; returned for clients that need it. */
  token: string;
  expiresInSeconds: number;
}

export interface MediaPort {
  /** Pre-signed upload URL for a private bucket object (§14). */
  createUploadUrl(input: { bucket: string; path: string; contentType?: string }): Promise<SignedUpload>;
  /** Short-lived download URL for a private object (§14). */
  createSignedDownloadUrl(input: { bucket: string; path: string; expiresInSeconds?: number }): Promise<string>;
  /**
   * Server-side write. Unlike `createUploadUrl`, the bytes go through the
   * API — which is correct for artefacts the PLATFORM issues rather than
   * the user uploads: a sealed document must never be writable by a
   * client holding a signed URL.
   */
  putObject(input: {
    bucket: string;
    path: string;
    bytes: Uint8Array;
    contentType?: string;
  }): Promise<void>;
  /** Server-side read, for re-hashing a stored object during verification. */
  getObject(input: { bucket: string; path: string }): Promise<Uint8Array>;
}

export const MEDIA_PORT = Symbol('MEDIA_PORT');
