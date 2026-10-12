import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { DocumentType } from '../contract/dto';

/**
 * Renders the PDF that gets sealed.
 *
 * `pdf-lib`, not pdfkit or headless Chromium. Chromium is 300MB+ and
 * would not fit beside the other tenant on the current box; pdfkit reads
 * its font metrics off the filesystem, which webpack bundles badly.
 * `pdf-lib` is pure JS with the standard 14 fonts built in.
 *
 * DETERMINISM. Creation and modification dates are set from the
 * document's own issue time, never from the render clock, and no random
 * identifiers are emitted. Rendering the same payload twice therefore
 * produces the same bytes. We still render only ONCE and serve the stored
 * object forever — but a renderer whose output drifts would make the
 * stored hash impossible to reason about.
 */

export interface RenderInput {
  type: DocumentType;
  number: string;
  issuedAt: Date;
  payload: Record<string, unknown>;
  /** Printed under the number so a holder can check it themselves. */
  verifyUrl: string;
}

const TITLES: Record<DocumentType, string> = {
  reservation_confirmation: 'CONFIRMATION DE RÉSERVATION',
  quotation: 'DEVIS',
  purchase_order: 'BON DE COMMANDE',
  invoice: 'FACTURE',
  credit_note: 'AVOIR',
  receipt: 'REÇU',
};

/** `1 234,56 DZD` from integer minor units — the house Money shape. */
function formatMoney(amountMinor: number, currency: string): string {
  const major = (amountMinor / 100).toFixed(2).replace('.', ',');
  return `${major.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${currency}`;
}

function asLines(payload: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      const money = value as { amountMinor?: number; currency?: string };
      if (typeof money.amountMinor === 'number' && typeof money.currency === 'string') {
        out.push([key, formatMoney(money.amountMinor, money.currency)]);
        continue;
      }
      out.push([key, JSON.stringify(value)]);
      continue;
    }
    out.push([key, String(value)]);
  }
  return out;
}

export async function renderDocument(input: RenderInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.45, 0.45, 0.45);
  let y = 780;

  page.drawText('JustGo', { x: 50, y, size: 20, font: bold, color: ink });
  page.drawText(TITLES[input.type], { x: 50, y: y - 26, size: 13, font: bold, color: ink });
  y -= 60;

  page.drawText(`N° ${input.number}`, { x: 50, y, size: 11, font: bold, color: ink });
  page.drawText(input.issuedAt.toISOString().slice(0, 10), {
    x: 450, y, size: 11, font, color: ink,
  });
  y -= 14;
  page.drawLine({
    start: { x: 50, y }, end: { x: 545, y },
    thickness: 0.7, color: rgb(0.8, 0.8, 0.8),
  });
  y -= 28;

  for (const [label, value] of asLines(input.payload)) {
    if (y < 120) break; // one page; overflow is a renderer concern, not a seal one
    page.drawText(label, { x: 50, y, size: 9, font, color: muted });
    page.drawText(value.slice(0, 70), { x: 200, y, size: 10, font, color: ink });
    y -= 18;
  }

  // Verification block. A holder of the paper must be able to check it
  // without trusting whoever handed it to them.
  page.drawText('Vérifier ce document :', { x: 50, y: 90, size: 8, font, color: muted });
  page.drawText(input.verifyUrl, { x: 50, y: 76, size: 8, font, color: ink });
  page.drawText(
    'Ce document est scellé cryptographiquement. Toute modification invalide le sceau.',
    { x: 50, y: 56, size: 7, font, color: muted },
  );

  doc.setTitle(`${TITLES[input.type]} ${input.number}`);
  doc.setProducer('JustGo');
  doc.setCreator('JustGo');
  // From the document, not the clock — see the determinism note above.
  doc.setCreationDate(input.issuedAt);
  doc.setModificationDate(input.issuedAt);

  return doc.save({ useObjectStreams: false });
}
