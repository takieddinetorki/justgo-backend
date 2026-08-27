import { Injectable } from '@nestjs/common';
import type { OcrProvider, RegistrationDraft } from '../contract/ocr.port';

/**
 * Deterministic OCR stub (§14). Real cloud/self-hosted OCR plugs in behind
 * OcrProvider later; until then this derives a draft from the object path so
 * the scan flow is exercisable end to end. Always low-confidence — the client
 * MUST confirm before committing.
 */
@Injectable()
export class StubOcrProvider implements OcrProvider {
  async scanRegistration(input: { bucket: string; path: string }): Promise<RegistrationDraft> {
    // path convention for the stub: ".../<brand>_<model>_<year>_<plate>.jpg"
    const base = input.path.split('/').pop() ?? '';
    const [brand, model, year, plate] = base.replace(/\.[a-z0-9]+$/i, '').split('_');
    return {
      vin: null,
      brand: brand || null,
      model: model || null,
      plate: plate || null,
      year: year && /^\d{4}$/.test(year) ? Number(year) : null,
      confidence: 0.4,
    };
  }
}
