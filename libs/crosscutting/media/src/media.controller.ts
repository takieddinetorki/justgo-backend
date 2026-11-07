import { Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { Throttle } from '@nestjs/throttler';
import { ValidationError } from '@justgo/kernel';
import { MEDIA_PORT, type MediaPort, type SignedUpload } from './contract/media.port';
import { OCR_PROVIDER, type OcrProvider, type RegistrationDraft } from './contract/ocr.port';

/**
 * Who may ask for a download URL, per bucket.
 *
 * `shared` — anyone signed in. The object is already published to people
 * who are not its owner: a photo in the feed, a shop's logo in the
 * directory, a car in the listings. Restricting these to the uploader is
 * the same as not serving them at all.
 *
 * `owner` — only objects under the caller's own `{accountId}/` prefix. An
 * identity document is not published to anybody.
 *
 * A bucket that is in NEITHER list cannot be signed here at all, and
 * `documents` is deliberately one of them: a facture is reached through
 * `/v1/documents/{id}/download`, which checks who is asking against the
 * order it belongs to. Routing it through a generic media endpoint would
 * quietly replace that check with "holds any session".
 */
const SHARED_BUCKETS = new Set([
  'post-media',
  'avatars',
  'supplier-media',
  'vehicle-photos',
  'part-photos',
]);
const OWNER_BUCKETS = new Set(['registrations', 'driver-documents', 'message-attachments']);

const downloadSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            bucket: z.string().min(1).max(64),
            path: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    expiresInSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
  })
  .strict();

export interface SignedDownload {
  bucket: string;
  path: string;
  /** null when Storage has no such object — a deleted image, not an error. */
  url: string | null;
  expiresAt: string | null;
}

const uploadSchema = z
  .object({
    bucket: z.enum([
      'registrations',
      'vehicle-photos',
      'part-photos',
      'avatars',
      'message-attachments',
      'post-media',
      'driver-documents',
      'supplier-media',
    ]),
    filename: z.string().min(1).max(200),
    contentType: z.string().max(100).optional(),
  })
  .strict();

const scanSchema = z
  .object({
    bucket: z.literal('registrations').default('registrations'),
    path: z.string().min(1).max(300),
  })
  .strict();

/**
 * Media endpoints (§14/§15). Uploads are pre-signed and go straight to
 * storage; /v1/vehicles/scan returns an OCR DRAFT the client confirms before
 * creating the vehicle — never auto-committed.
 */
@Controller()
export class MediaController {
  constructor(
    @Inject(MEDIA_PORT) private readonly media: MediaPort,
    @Inject(OCR_PROVIDER) private readonly ocr: OcrProvider,
  ) {}

  /*
    Each call hands out a pre-signed PUT — a writable handle into a bucket.
    Unbounded, it is a way to fill our storage from a single account.
  */
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Post('media/uploads')
  @RequirePermissions()
  async createUpload(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<SignedUpload> {
    const parsed = uploadSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid upload request', { issues: parsed.error.issues });
    // namespace every object under the account so paths cannot collide/leak
    const path = `${auth.accountId}/${Date.now()}_${parsed.data.filename}`;
    return this.media.createUploadUrl({
      bucket: parsed.data.bucket,
      path,
      contentType: parsed.data.contentType,
    });
  }

  /**
   * `POST /v1/media/downloads` — turn stored (bucket, path) refs into URLs
   * something can actually render.
   *
   * THE READ SIDE WAS MISSING. Every bucket is private, the API never
   * proxies bytes, and the DTOs hand out (bucket, path) on the stated
   * assumption that "the client asks for a fresh signed URL when it needs
   * the bytes" — but there was nothing to ask. Uploads worked, rows were
   * written, and no image in the product could be displayed.
   *
   * Batched because the caller is a feed, not a page: one POST per bucket
   * to Storage, however many objects are on screen.
   */
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Post('media/downloads')
  @RequirePermissions()
  async createDownloads(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ items: SignedDownload[] }> {
    const parsed = downloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid download request', { issues: parsed.error.issues });
    }

    /*
      Refuse the whole request rather than returning a null url for the
      items that are not allowed. A client asking for a bucket it may not
      read is a bug in the client, and a per-item null would let it look
      like an ordinary missing image for as long as nobody checked.
    */
    for (const item of parsed.data.items) {
      const shared = SHARED_BUCKETS.has(item.bucket);
      const owned = OWNER_BUCKETS.has(item.bucket) && item.path.startsWith(`${auth.accountId}/`);
      if (!shared && !owned) {
        throw new ValidationError('That object cannot be read through this endpoint', {
          bucket: item.bucket,
        });
      }
    }

    const ttl = parsed.data.expiresInSeconds ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const byBucket = new Map<string, string[]>();
    for (const item of parsed.data.items) {
      const paths = byBucket.get(item.bucket) ?? [];
      paths.push(item.path);
      byBucket.set(item.bucket, paths);
    }

    const signed = new Map<string, string>();
    for (const [bucket, paths] of byBucket) {
      const urls = await this.media.createSignedDownloadUrls({
        bucket,
        paths,
        expiresInSeconds: ttl,
      });
      for (const [path, url] of urls) signed.set(`${bucket}/${path}`, url);
    }

    return {
      items: parsed.data.items.map((item) => {
        const url = signed.get(`${item.bucket}/${item.path}`) ?? null;
        return { bucket: item.bucket, path: item.path, url, expiresAt: url ? expiresAt : null };
      }),
    };
  }

  @Post('vehicles/scan')
  @RequirePermissions('vehicle.manage')
  async scan(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ draft: RegistrationDraft }> {
    const parsed = scanSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid scan request', { issues: parsed.error.issues });
    // the object must live under the caller's namespace
    if (!parsed.data.path.startsWith(`${auth.accountId}/`)) {
      throw new ValidationError('Scan path must be within your own upload namespace');
    }
    const draft = await this.ocr.scanRegistration({ bucket: parsed.data.bucket, path: parsed.data.path, locale: auth.locale });
    return { draft };
  }
}
