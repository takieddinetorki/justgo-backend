import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentAuth, Public, RequirePermissions, type AuthContext } from '@justgo/auth';
import { asId, ValidationError, type Uuid } from '@justgo/kernel';
import { DOCUMENTS_PORT, type DocumentsPort } from './contract/documents.port';
import type { DocumentDTO, VerificationResult } from './contract/dto';
import { DOCUMENT_SIGNER, type DocumentSigner } from './contract/signer.port';

const verifySchema = z
  .object({
    /** Base64 of the file the holder has, to compare against ours. */
    file: z.string().max(12_000_000).optional(),
  })
  .strict();

const voidSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(DOCUMENTS_PORT) private readonly documents: DocumentsPort,
    @Inject(DOCUMENT_SIGNER) private readonly signer: DocumentSigner,
  ) {}

  /** Documents issued to the caller. */
  @Get()
  @RequirePermissions()
  async mine(
    @CurrentAuth() auth: AuthContext,
    @Query('limit') limit?: string,
  ): Promise<{ items: DocumentDTO[] }> {
    return { items: await this.documents.listForAccount(auth.accountId, limit ? Number(limit) : undefined) };
  }

  /** Short-lived signed URL. The bucket is private; there is no public link. */
  @Get(':id/download')
  @RequirePermissions()
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ url: string }> {
    return { url: await this.documents.downloadUrl(auth.accountId, asId<Uuid>(id)) };
  }

  /**
   * The public keys, so anyone can verify a document offline.
   *
   * Without this, "authentic" only means "our API said so" — which proves
   * nothing to a third party who does not trust us. Publishing the key is
   * what makes the signature evidence rather than assertion.
   */
  @Get('keys')
  @Public()
  keys(): { keys: Array<{ keyId: string; algo: string; publicKey: string }> } {
    return { keys: this.signer.publicKeys() };
  }

  /**
   * `GET /v1/documents/verify/{number}` — public, and printed on every
   * page as a QR target.
   *
   * Returns status and authenticity only: no amounts, no parties. Numbers
   * are guessable and this endpoint is open to the world.
   */
  @Get('verify/:number')
  @Public()
  async verify(@Param('number') number: string): Promise<VerificationResult> {
    return this.documents.verifyByNumber(number);
  }

  /**
   * Stronger check: the holder sends the file THEY have and we compare it
   * against the bytes we sealed. Proves their copy is the real one rather
   * than asking them to trust our screen.
   */
  @Post('verify/:number')
  @Public()
  async verifyFile(
    @Param('number') number: string,
    @Body() body: unknown,
  ): Promise<VerificationResult> {
    const parsed = verifySchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid verification request', { issues: parsed.error.issues });
    const supplied = parsed.data.file ? Buffer.from(parsed.data.file, 'base64') : undefined;
    return this.documents.verifyByNumber(number, supplied);
  }

  /**
   * Annul a document. Admin only, and deliberately NOT a delete: the
   * stored bytes stay exactly as issued, so a voided document remains
   * provably authentic while ceasing to be valid.
   */
  @Post(':id/void')
  @RequirePermissions('platform.admin')
  async voidDocument(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DocumentDTO> {
    const parsed = voidSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Invalid void request', { issues: parsed.error.issues });
    return this.documents.voidDocument({
      documentId: asId<Uuid>(id),
      voidedBy: auth.accountId,
      reason: parsed.data.reason,
    });
  }
}
