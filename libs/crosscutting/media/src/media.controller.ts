import { Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions, type AuthContext } from '@justgo/auth';
import { ValidationError } from '@justgo/kernel';
import { MEDIA_PORT, type MediaPort, type SignedUpload } from './contract/media.port';
import { OCR_PROVIDER, type OcrProvider, type RegistrationDraft } from './contract/ocr.port';

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
