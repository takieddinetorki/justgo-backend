/**
 * OCR provider port (§14). A registration document is OCR'd into a DRAFT that
 * the user confirms — never auto-committed. Cloud or self-hosted providers
 * plug in behind this interface; the default is a deterministic stub.
 */
export interface RegistrationDraft {
  vin: string | null;
  brand: string | null;
  model: string | null;
  plate: string | null;
  year: number | null;
  /** 0..1 model confidence, surfaced so the client can flag low-trust fields. */
  confidence: number;
}

export interface OcrProvider {
  /** Extracts a draft from an uploaded document at `bucket/path`. */
  scanRegistration(input: { bucket: string; path: string; locale?: string }): Promise<RegistrationDraft>;
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');
