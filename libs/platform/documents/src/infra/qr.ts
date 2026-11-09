import { rgb, type PDFPage } from 'pdf-lib';
import qrcode from 'qrcode-generator';

/**
 * Draws the verification QR that every sealed document carries.
 *
 * WHY THIS FILE EXISTS. Both renderers already printed the verify URL as
 * text, and the controller's own comments called that URL "the QR target
 * printed on every document" — but nothing ever drew a QR. A holder of
 * the paper was expected to retype a sixty-character URL to check the
 * document they are holding, which nobody does, which means in practice
 * the verification endpoint existed and was never reached.
 *
 * VECTOR, NOT A RASTER. Each dark module is a filled rectangle, so the
 * code stays sharp at any zoom and at any printer resolution, and the
 * page gains about two kilobytes rather than embedding a PNG. It also
 * keeps the renderer free of an image encoder, which is one more thing
 * that would have to behave identically inside the webpack bundle.
 *
 * DETERMINISM. `qrcode-generator` picks its version and mask from the
 * data by the specification's own rules — no clock, no randomness — so
 * the same URL always produces the same modules, and therefore the same
 * page bytes. That matters because these bytes get hashed and signed.
 */

/** Quiet zone, in modules. Four is the minimum the QR spec allows. */
const QUIET = 4;

export interface QrBox {
  /** What the scanner should open. */
  text: string;
  /** Lower-left corner of the box, including its quiet zone. */
  x: number;
  y: number;
  /** Width and height of that box, in points. */
  size: number;
}

/**
 * Draw `text` as a QR code inside the given box.
 *
 * Throws rather than degrading. A missing QR on a facture is permanent —
 * the bytes are sealed and the document is never re-rendered — whereas a
 * throw happens inside the issuing transaction, where it is loud, and
 * the reactor retries. Issuing a fiscal document that silently lacks its
 * verification path is the worse of the two outcomes.
 */
export function drawQrCode(page: PDFPage, box: QrBox): void {
  const qr = qrcode(0, 'M');
  qr.addData(box.text);
  qr.make();

  const count = qr.getModuleCount();
  const module = box.size / (count + QUIET * 2);

  /*
    A white card under the whole thing, quiet zone included. The quiet
    zone is part of the symbol, not margin: without it a scanner cannot
    find the finder patterns, and a QR dropped straight onto a coloured
    or textured background fails to read for reasons nobody can see.
  */
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.size,
    height: box.size,
    color: rgb(1, 1, 1),
  });

  const left = box.x + QUIET * module;
  const top = box.y + box.size - QUIET * module;
  const ink = rgb(0, 0, 0);

  /*
    One rectangle per RUN of dark modules, not per module. A version-3
    code is about five hundred dark squares; merged into horizontal runs
    it is roughly half that, and each one is a shorter operator. Adjacent
    rectangles share an exact edge, so no hairline shows between them.
  */
  for (let row = 0; row < count; row += 1) {
    let runStart = -1;
    for (let col = 0; col <= count; col += 1) {
      const dark = col < count && qr.isDark(row, col);
      if (dark && runStart === -1) {
        runStart = col;
      } else if (!dark && runStart !== -1) {
        page.drawRectangle({
          x: left + runStart * module,
          y: top - (row + 1) * module,
          width: (col - runStart) * module,
          height: module,
          color: ink,
        });
        runStart = -1;
      }
    }
  }
}
