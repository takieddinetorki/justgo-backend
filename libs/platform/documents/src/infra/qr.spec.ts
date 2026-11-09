import jsQR from 'jsqr';
import { drawQrCode } from './qr';
import { renderInvoice } from './invoice-renderer';
import { renderDocument } from './pdf-renderer';

const VERIFY_URL = 'http://168.231.87.48:3100/v1/documents/verify/FA-2026-000042';

/*
  The REAL implementation, wrapped so the calls can be counted. Mocking it
  away would leave the renderers untested against the thing that was
  actually wrong with them — that they never called it.
*/
jest.mock('./qr', () => {
  const actual = jest.requireActual('./qr');
  return { ...actual, drawQrCode: jest.fn(actual.drawQrCode) };
});
const drawn = drawQrCode as unknown as jest.Mock;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  white: boolean;
}

/** A page that records rectangles instead of writing a PDF. */
function recordingPage(): { rects: Rect[]; page: Parameters<typeof drawQrCode>[0] } {
  const rects: Rect[] = [];
  const page = {
    drawRectangle: (o: {
      x: number;
      y: number;
      width: number;
      height: number;
      color: { red: number; green: number; blue: number };
    }) => {
      rects.push({
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        white: o.color.red === 1 && o.color.green === 1 && o.color.blue === 1,
      });
    },
  } as unknown as Parameters<typeof drawQrCode>[0];
  return { rects, page };
}

/**
 * Paint the recorded rectangles into a bitmap, PDF coordinates flipped,
 * so a decoder that knows nothing about how they were produced can read
 * them. This is the check that matters: not "we drew some squares" but
 * "what we drew is a QR code, and it says the right thing".
 */
function rasterize(rects: Rect[], box: { x: number; y: number; size: number }, px: number) {
  const side = Math.round(box.size * px);
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  const put = (r: Rect, value: number) => {
    const x0 = Math.round((r.x - box.x) * px);
    const y1 = Math.round((box.y + box.size - r.y) * px);
    const w = Math.round(r.width * px);
    const h = Math.round(r.height * px);
    for (let yy = y1 - h; yy < y1; yy += 1) {
      for (let xx = x0; xx < x0 + w; xx += 1) {
        if (xx < 0 || yy < 0 || xx >= side || yy >= side) continue;
        const i = (yy * side + xx) * 4;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
      }
    }
  };
  for (const r of rects) put(r, r.white ? 255 : 0);
  return { data, side };
}

describe('verification QR', () => {
  const box = { x: 469, y: 46, size: 76 };

  it('draws something an ordinary QR decoder can read', () => {
    const { rects, page } = recordingPage();
    drawQrCode(page, { text: VERIFY_URL, ...box });

    const { data, side } = rasterize(rects, box, 8);
    const found = jsQR(data, side, side);
    expect(found?.data).toBe(VERIFY_URL);
  });

  it('puts a white quiet zone under the whole symbol', () => {
    const { rects, page } = recordingPage();
    drawQrCode(page, { text: VERIFY_URL, ...box });

    /*
      The first rectangle must be the white card, and it must cover the
      box exactly. Without the quiet zone a scanner cannot locate the
      finder patterns, and a code dropped onto a coloured background
      fails to read for a reason that is invisible on screen.
    */
    const card = rects[0];
    expect(card.white).toBe(true);
    expect([card.x, card.y, card.width, card.height]).toEqual([box.x, box.y, box.size, box.size]);
    expect(rects.slice(1).every((r) => !r.white)).toBe(true);
  });

  it('merges runs instead of emitting one rectangle per module', () => {
    const { rects, page } = recordingPage();
    drawQrCode(page, { text: VERIFY_URL, ...box });
    const dark = rects.slice(1);
    // A version-3 code is ~500 dark modules; merged, it is far fewer.
    expect(dark.length).toBeGreaterThan(50);
    expect(dark.length).toBeLessThan(400);
  });

  /*
    The renderers are what actually ship. Both printed the verify URL as
    text and drew no QR at all, while the controller's comments described
    that URL as "the QR target printed on every document" — so these
    assert against the real PDF rather than the helper.
  */
  beforeEach(() => drawn.mockClear());

  it('is on a rendered facture', async () => {
    await renderInvoice({
      number: 'FA-2026-000042',
      issuedAt: new Date('2026-11-09T10:00:00Z'),
      currency: 'DZD',
      seller: {
        legalName: 'SARL Test',
        address: '1 rue Test',
        city: 'Alger',
        country: 'DZ',
        nif: '001',
        nis: '002',
        rc: '003',
        taxArticle: '004',
      },
      buyer: { name: 'Client Test', nif: null },
      lines: [{ description: 'Pièce', quantity: 1, unitTtcMinor: 100000 }],
      tvaRatePercent: 19,
      verifyUrl: VERIFY_URL,
    });
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(drawn.mock.calls[0][1]).toEqual({ text: VERIFY_URL, x: 469, y: 46, size: 76 });
  });

  it('is on every other document type too', async () => {
    await renderDocument({
      type: 'reservation_confirmation',
      number: 'RC-2026-000007',
      issuedAt: new Date('2026-11-09T10:00:00Z'),
      payload: { service: 'Vidange' },
      verifyUrl: VERIFY_URL,
    });
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(drawn.mock.calls[0][1].text).toBe(VERIFY_URL);
  });

  /*
    These bytes get hashed and signed, and the hash is what the public
    verify endpoint re-computes. A renderer whose output drifted between
    two runs would make that hash impossible to reason about.
  */
  it('does not make the output drift between renders', async () => {
    const args = {
      type: 'reservation_confirmation' as const,
      number: 'RC-2026-000007',
      issuedAt: new Date('2026-11-09T10:00:00Z'),
      payload: { service: 'Vidange' },
      verifyUrl: VERIFY_URL,
    };
    const a = await renderDocument(args);
    const b = await renderDocument(args);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });
});
