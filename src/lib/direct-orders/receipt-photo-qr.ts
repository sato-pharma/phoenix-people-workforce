import { logError } from "@/lib/observability/log";

// ─────────────────────────────────────────────────────────────────────────────
// Reads the QR printed on a receipt sheet out of the photo of it (owner, 28 Nov 2026: Phoenix
// recognises the receipt "اوتوماتيك بغض النظر عن اللي هم كاتبينه بايديهم" — whatever was typed).
//
// The SERVER's read is the one that counts. The camera on the order page turns green when it sees the
// QR, but that is only a help to the person holding the phone; a photo that did not pass through it
// (Finance's "Choose file") is read here all the same. What the text means is decided in
// receipt-rules.ts (classifyReceiptPhotoQr); this file only turns pixels into text.
//
// A phone photo is 3,000–4,000 px wide and the QR is 24 mm on the sheet, so it is tried at a few widths,
// smallest first (each read is ~0.3 s). A PDF, an unreadable image or a failure of the reader is "no QR
// read": the original then waits for review, which is the safe side — it is never let in unread.
// ─────────────────────────────────────────────────────────────────────────────

const WIDTHS = [1200, 1800, 2600] as const;

type QrReader = (bytes: Uint8Array, contentType: string) => Promise<string[]>;

let testReader: QrReader | null = null;

/** Tests only: stand in for the reader (the suite's stand-in photos are not real pictures). Pass null to restore. */
export function __setReceiptQrReaderForTests(reader: QrReader | null): void {
  testReader = reader;
}

async function readWithJsQr(bytes: Uint8Array, contentType: string): Promise<string[]> {
  if (!/^image\//i.test(contentType)) return [];
  const [{ default: sharp }, { default: jsQR }] = await Promise.all([import("sharp"), import("jsqr")]);
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta = await sharp(input, { failOn: "none" }).metadata();
  const fullWidth = meta.width ?? 0;
  if (fullWidth === 0) return [];
  for (const wanted of WIDTHS) {
    const width = Math.min(wanted, fullWidth);
    const { data, info } = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, {
      inversionAttempts: "attemptBoth",
    });
    if (found?.data) return [found.data];
    if (width >= fullWidth) break;
  }
  return [];
}

/** The text of the QR read from a receipt photo — none when no QR could be read. Never throws. */
export async function readReceiptQrTexts(bytes: Uint8Array, contentType: string): Promise<string[]> {
  try {
    return await (testReader ?? readWithJsQr)(bytes, contentType);
  } catch (error) {
    logError("A receipt photo's QR could not be read", { labels: { event: "direct_order_receipt_qr_read_failed" }, error });
    return [];
  }
}
