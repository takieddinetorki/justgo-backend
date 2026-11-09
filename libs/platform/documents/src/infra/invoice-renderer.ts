import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { drawQrCode } from './qr';
import { groupContentHash } from '../domain/content-hash';
import { breakdownFromTtc, formatMoney } from '../application/tax';

/**
 * Renders a *facture* carrying the mentions Algerian law requires.
 *
 * Separate from the generic renderer because an invoice is not a
 * key/value sheet: it needs a seller block with fiscal identifiers, a
 * buyer block, priced lines, and an HT / TVA / TTC total that reconciles.
 * Rendering it through the generic path would produce something that
 * looks like a receipt and is not a tax document.
 *
 * Deterministic for the same reason as the generic renderer: dates come
 * from the document, never the clock.
 */

export interface InvoiceSeller {
  legalName: string;
  address: string | null;
  city: string | null;
  country: string | null;
  nif: string;
  nis: string;
  rc: string;
  taxArticle: string;
}

export interface InvoiceBuyer {
  name: string;
  address?: string | null;
  nif?: string | null;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  /** Unit price INCLUDING tax, in minor units — see tax.ts. */
  unitTtcMinor: number;
}

export interface InvoiceRenderInput {
  number: string;
  issuedAt: Date;
  currency: string;
  seller: InvoiceSeller;
  buyer: InvoiceBuyer;
  lines: InvoiceLine[];
  tvaRatePercent: number;
  verifyUrl: string;
  /**
   * The facture's content hash, printed in full and encoded in the QR.
   * This is the value the verification endpoint resolves.
   */
  contentHash: string;
  /**
   * Where to type the hash by hand — the verification page without the
   * hash on the end. Printed because the full `verifyUrl` is now over a
   * hundred characters and nobody is typing that off a page.
   */
  verifyBaseUrl: string;
  /** Printed when the document has been annulled. */
  voidedNotice?: string | null;
}

export async function renderInvoice(input: InvoiceRenderInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // Courier for the hash: 0/O and 1/l have to be distinguishable on paper.
  const mono = await doc.embedFont(StandardFonts.Courier);

  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.45, 0.45, 0.45);
  const line = rgb(0.8, 0.8, 0.8);
  const text = (s: string, x: number, y: number, size = 9, f = font, c = ink) =>
    page.drawText(s, { x, y, size, font: f, color: c });

  let y = 790;
  text('FACTURE', 50, y, 18, bold);
  text(`N° ${input.number}`, 50, y - 22, 11, bold);
  text(`Date : ${input.issuedAt.toISOString().slice(0, 10)}`, 400, y - 22, 10);
  y -= 50;

  // ── Seller: every identifier below is legally required ──────────
  text('VENDEUR', 50, y, 8, bold, muted);
  y -= 14;
  text(input.seller.legalName, 50, y, 10, bold);
  y -= 12;
  for (const l of [
    [input.seller.address, input.seller.city].filter(Boolean).join(', '),
    `NIF : ${input.seller.nif}`,
    `NIS : ${input.seller.nis}`,
    `RC : ${input.seller.rc}`,
    `Article d'imposition : ${input.seller.taxArticle}`,
  ]) {
    if (l) {
      text(l, 50, y, 8, font, muted);
      y -= 11;
    }
  }

  // ── Buyer ───────────────────────────────────────────────────────
  let by = 740 - 50;
  text('CLIENT', 330, by, 8, bold, muted);
  by -= 14;
  text(input.buyer.name, 330, by, 10, bold);
  by -= 12;
  if (input.buyer.address) {
    text(input.buyer.address, 330, by, 8, font, muted);
    by -= 11;
  }
  if (input.buyer.nif) text(`NIF : ${input.buyer.nif}`, 330, by, 8, font, muted);

  y = Math.min(y, by) - 26;

  // ── Lines ───────────────────────────────────────────────────────
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.7, color: line });
  y -= 13;
  text('DÉSIGNATION', 50, y, 8, bold, muted);
  text('QTÉ', 330, y, 8, bold, muted);
  text('P.U. TTC', 390, y, 8, bold, muted);
  text('MONTANT TTC', 470, y, 8, bold, muted);
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.7, color: line });
  y -= 16;

  /*
    One page, and the table has to stop while there is still room for the
    totals and the footer below it. It had no bound at all: a long invoice
    printed its amount column straight through the verification block, and
    now that a QR sits at x=469..545 / y=46..122 — directly under the
    MONTANT TTC column — an unbounded table would print over the code and
    cost the document the only verification route anybody uses.

    The TOTAL still covers every line, including the ones not drawn, so
    the arithmetic on the page is never wrong — but a line that was not
    printed is said so, out loud, rather than disappearing.
  */
  const TABLE_FLOOR = 215;
  let ttcTotal = 0;
  let drawn = 0;
  for (const l of input.lines) {
    const lineTtc = l.unitTtcMinor * l.quantity;
    ttcTotal += lineTtc;
    if (y < TABLE_FLOOR) continue;
    text(l.description.slice(0, 58), 50, y, 9);
    text(String(l.quantity), 330, y, 9);
    text(formatMoney(l.unitTtcMinor, input.currency), 390, y, 9);
    text(formatMoney(lineTtc, input.currency), 470, y, 9);
    y -= 15;
    drawn += 1;
  }
  const hidden = input.lines.length - drawn;
  if (hidden > 0) {
    text(
      `… ${hidden} ligne(s) supplémentaire(s), comprises dans le total ci-dessous.`,
      50,
      y,
      8,
      font,
      muted,
    );
    y -= 15;
  }

  // ── Totals. HT and TVA are derived so they always reconcile ─────
  const t = breakdownFromTtc(ttcTotal, input.tvaRatePercent);
  y -= 8;
  page.drawLine({ start: { x: 330, y }, end: { x: 545, y }, thickness: 0.7, color: line });
  y -= 15;
  for (const [label, value, strong] of [
    ['Total HT', formatMoney(t.htMinor, input.currency), false],
    [`TVA ${t.ratePercent}%`, formatMoney(t.tvaMinor, input.currency), false],
    ['TOTAL TTC', formatMoney(t.ttcMinor, input.currency), true],
  ] as Array<[string, string, boolean]>) {
    text(label, 330, y, strong ? 10 : 9, strong ? bold : font);
    text(value, 460, y, strong ? 10 : 9, strong ? bold : font);
    y -= strong ? 18 : 14;
  }

  if (input.voidedNotice) {
    text(input.voidedNotice, 50, y - 10, 10, bold, rgb(0.7, 0.1, 0.1));
  }

  // ── Verification block ──────────────────────────────────────────
  /*
    The QR carries the same URL printed beside it. Both, not either: a
    scan is what anybody actually does, and the printed URL is what still
    works on a creased or photocopied page.
  */
  drawQrCode(page, { text: input.verifyUrl, x: 449, y: 46, size: 96 });
  const [hashTop, hashBottom] = groupContentHash(input.contentHash);
  text('EMPREINTE DE LA FACTURE (SHA-256)', 50, 112, 7, bold, muted);
  text(hashTop, 50, 99, 8, mono);
  text(hashBottom, 50, 88, 8, mono);
  text('Scannez le code, ou saisissez cette empreinte sur :', 50, 72, 7, font, muted);
  text(input.verifyBaseUrl, 50, 61, 8);
  text(
    'Document scellé cryptographiquement. Toute modification invalide le sceau.',
    50,
    48,
    7,
    font,
    muted,
  );

  doc.setTitle(`Facture ${input.number}`);
  doc.setProducer('JustGo');
  doc.setCreator('JustGo');
  doc.setCreationDate(input.issuedAt);
  doc.setModificationDate(input.issuedAt);

  return doc.save({ useObjectStreams: false });
}
