/**
 * Where a document says it can be checked, and the code that takes you there.
 *
 * The certificate and the journey each carry a QR code (owner, 13 Sep 2026)
 * that opens the certificate check on the company's own website:
 * `satopharma.com/ftp/<verification id>`. That route already exists and
 * already answers for the 2025 cohort — it is a hidden page on the main site,
 * noindex and linked from nowhere, reached by scanning — so the portal's only
 * job is to print the address it expects. It is keyed by
 * `profiles.verification_id` (112), a random UUID, and deliberately NOT by the
 * FTP number the journey prints: that is 'FTP-' and eight digits, so a page
 * keyed by it was one guess away from anybody's name and record (owner,
 * 13 Sep 2026). The page is the company's and not this app's: the
 * portal has no public surface by design, and a verification page on a
 * login-walled app would be one nobody holding the paper could open.
 *
 * WHAT A SCAN SHOWS DEPENDS ON A PRESS, NOT ON THIS FILE. The site looks the
 * id up in its own registry and then asks the portal
 * certificate_is_certified() (113) on every visit, answering "not found"
 * unless an admin has pressed Certify beside that intern on /admin/interns.
 * Putting an intern's name on a public page is the owner's call, one intern
 * at a time, and Withdraw takes it down again without a deploy.
 *
 * The code is small and quiet — one navy, fine square modules, the finders'
 * centres in the brand blue of the page's seams — and carries no mark. The
 * owner turned down a large, coloured, liquid code with the logo in it
 * ("premium polish … make it smaller", 13 Sep 2026): on a signed page the code
 * is a security feature, set like the seal, not a second logo competing with
 * the one in the band. At this size a mark would be fifteen points wide and
 * illegible, and the white field it needs costs a reader modules the smaller
 * print can no longer spare.
 */

import type { Pdf, RgbColor } from "./pdf.ts";
import { drawStyledQr, encodeQr, type QrCode, type QrStyle } from "./qr.ts";

export const VERIFY_ORIGIN = "https://satopharma.com";

/** The website's certificate check for one record. */
export function verificationUrl(verificationId: string): string {
  return `${VERIFY_ORIGIN}/ftp/${encodeURIComponent(verificationId)}`;
}

/* The documents' navy (the name's colour) and brand blue, repeated rather than
   imported: both PDFs keep their palettes private, and a QR code is exactly
   the thing that must not change colour because a document was retuned —
   contrast is what a camera reads. */
const NAVY: RgbColor = [0.09, 0.188, 0.302];
const BRAND: RgbColor = [0.031, 0.475, 0.722];

/**
 * Square modules at 92% of their cell, in one ink.
 *
 * The hairline of paper between modules is what makes a code read as set
 * rather than stamped, and it is kept narrow because the code is small: at
 * 40pt a module is barely more than a point. Square, because OpenCV reading
 * the emitted page found rounded finders at print size in no attempt at all,
 * and diamonds in about half.
 */
export const VERIFY_STYLE: QrStyle = {
  from: NAVY,
  to: NAVY,
  eye: NAVY,
  pupil: BRAND,
  module: "square",
  pupilShape: "square",
  scale: 0.92,
};

/** The code for a record, at level H. Its `size` is what a caller spaces the
    quiet zone by, since a longer id can take the symbol up a version. */
export function verificationCode(verificationId: string): QrCode {
  return encodeQr(verificationUrl(verificationId), { ecc: "H" });
}

/**
 * Draw a record's verification code, `side` points square at x, y. The caller
 * keeps QR_QUIET modules of white around it.
 */
export function drawVerificationQr(
  doc: Pdf,
  code: QrCode,
  x: number,
  y: number,
  side: number,
): void {
  drawStyledQr(doc, code, x, y, side, VERIFY_STYLE);
}
