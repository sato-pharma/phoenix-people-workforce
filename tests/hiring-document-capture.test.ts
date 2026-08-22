import assert from "node:assert/strict";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import {
  buildScannedDocumentPdf,
  HIRING_DOCUMENT_SCAN_MODES,
  HIRING_SCAN_MAX_EDGE_PX,
  isHiringDocumentScanMode,
  polishDocumentPhoto,
  scanPagesToPdf,
} from "../src/lib/hiring-documents/document-scan.ts";
import {
  assertHiringDocumentFileAllowed,
  buildHiringDocumentFilePath,
  HIRING_DOCUMENT_ALLOWED_CONTENT_TYPES,
  HIRING_DOCUMENT_MAX_UPLOAD_BYTES,
  HIRING_DOCUMENTS_BUCKET,
} from "../src/lib/hiring-documents/file-storage.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Document capture: the scan behind the tick.
//
// Run against real images and a real PDF, in the same spirit as the invoice-scan tests: everything
// asserted here is a property of what actually comes out — tonal spread, colour survival, page
// geometry — so a change that quietly weakens the pipeline fails on the pixels rather than on a
// regex over the source.
// ─────────────────────────────────────────────────────────────────────────────

/** A dim desk photograph of a page: faint "print" on grey paper, the way a phone sees it indoors. */
async function dimPage(width = 800, height = 1100): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const x = i % width;
    const y = Math.floor(i / width);
    const isText = y % 36 < 5 && x % 11 < 8;
    const value = isText ? 120 : 140; // 20 levels apart out of 255
    raw[i * 3] = value;
    raw[i * 3 + 1] = value;
    raw[i * 3 + 2] = value;
  }
  return sharp(raw, { raw: { channels: 3, height, width } }).jpeg({ quality: 90 }).toBuffer();
}

/** A page carrying a strongly coloured mark — an official seal, an ID photograph. */
async function pageWithARedSeal(width = 600, height = 800): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const x = i % width;
    const y = Math.floor(i / width);
    const insideSeal = x > width - 180 && y > height - 180;
    raw[i * 3] = insideSeal ? 200 : 150;
    raw[i * 3 + 1] = insideSeal ? 30 : 150;
    raw[i * 3 + 2] = insideSeal ? 40 : 150;
  }
  return sharp(raw, { raw: { channels: 3, height, width } }).jpeg({ quality: 92 }).toBuffer();
}

const greySpread = async (bytes: Buffer) => {
  const stats = await sharp(bytes).stats();
  return stats.channels[0].max - stats.channels[0].min;
};

/**
 * How far apart the red and green channels are INSIDE the seal — 0 once greyscaled, large while the
 * colour survives.
 *
 * Measured on the seal's own corner rather than over the whole page on purpose: a seal occupies a
 * few percent of a certificate, so a whole-image channel mean dilutes it to a handful of levels and
 * the assertion stops being able to tell "colour kept" from "colour lost". First attempt at this
 * test did exactly that and read 5.2 for an image whose seal was fully, obviously red.
 */
const sealColourSeparation = async (bytes: Buffer) => {
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const size = Math.min(120, Math.floor(width / 6), Math.floor(height / 6));
  // The crop is materialised before `stats()` deliberately. `sharp(x).extract(...).stats()` reports
  // statistics for the SOURCE image and silently ignores everything queued in the pipeline, so the
  // first version of this helper measured the whole page while appearing to measure the seal — and
  // read an identical number whichever region it was pointed at.
  const cropped = await sharp(bytes)
    .extract({ height: size, left: width - size - 4, top: height - size - 4, width: size })
    .raw()
    .toBuffer();
  const stats = await sharp(cropped, { raw: { channels: 3, height: size, width: size } }).stats();
  return Math.abs(stats.channels[0].mean - stats.channels[1].mean);
};

export async function runHiringDocumentCaptureTests() {
  // ── The polish actually polishes ────────────────────────────────────────────
  // Same justification as the invoice pipeline: if the tonal spread does not move, this is CPU
  // spent on every capture to hand back the same photograph, and it should be deleted not defended.
  {
    const dim = await dimPage();
    const before = await greySpread(dim);
    const result = await polishDocumentPhoto({ bytes: dim, mimeType: "image/jpeg" });
    const after = await greySpread(result.bytes);

    assert.ok(result.polished, "a normal JPEG page must actually be polished, not passed through");
    assert.equal(result.mimeType, "image/jpeg", "a polished page is always re-encoded as JPEG");
    assert.ok(
      after > before * 3,
      `POLISH MUST LIFT CONTRAST: a desk photograph occupies a narrow band of greys and small print ` +
        `inside it is unreadable. Spread went ${before} → ${after}; under 3x means this step is ` +
        "spending CPU and returning the same picture",
    );
  }

  // ── Colour is the default, and that is the whole difference from the invoice pipeline ──
  // A birth certificate's seal, a national ID's photograph and a military card's stamp are the
  // marks that make the document verifiable. `prepareInvoicePhoto` greyscales — correctly, for an
  // invoice — and copying it here would destroy exactly the evidence this feature stores.
  {
    const sealed = await pageWithARedSeal();
    const colour = await polishDocumentPhoto({ bytes: sealed, mimeType: "image/jpeg" });
    const separation = await sealColourSeparation(colour.bytes);

    assert.ok(
      separation > 40,
      `THE DEFAULT MODE MUST KEEP COLOUR: an official seal is the mark that makes a certificate ` +
        `verifiable, and greyscaling it destroys the evidence. Red/green separation inside the seal ` +
        `was ${separation.toFixed(1)}; near zero means the default has been switched to greyscale`,
    );

    const grey = await polishDocumentPhoto({ bytes: sealed, mimeType: "image/jpeg", mode: "greyscale" });
    const greySeparated = await sealColourSeparation(grey.bytes);
    assert.ok(
      greySeparated < 2,
      `greyscale mode must actually remove colour; separation inside the seal was ${greySeparated.toFixed(1)}`,
    );
  }

  // ── EXIF orientation is corrected ───────────────────────────────────────────
  // Phones record orientation in metadata rather than rotating the pixels. A sideways certificate
  // is not "harder to read", it is filed wrong — and it prints wrong.
  {
    const tall = await sharp({
      create: { background: { b: 240, g: 240, r: 240 }, channels: 3, height: 400, width: 200 },
    })
      .withMetadata({ orientation: 6 }) // 6 = rotate 90° clockwise on display
      .jpeg()
      .toBuffer();

    const result = await polishDocumentPhoto({ bytes: tall, mimeType: "image/jpeg" });
    const rotated = await sharp(result.bytes).metadata();
    assert.ok(
      (rotated.width ?? 0) > (rotated.height ?? 0),
      "a page whose EXIF says 'rotate 90' must come out physically rotated, not merely tagged",
    );
  }

  // ── A large photograph is capped, a small one is not enlarged ───────────────
  {
    const huge = await sharp({
      create: { background: { b: 255, g: 255, r: 255 }, channels: 3, height: 3400, width: 2600 },
    })
      .jpeg()
      .toBuffer();
    const cappedResult = await polishDocumentPhoto({ bytes: huge, mimeType: "image/jpeg" });
    const capped = await sharp(cappedResult.bytes).metadata();
    assert.ok(
      Math.max(capped.width ?? 0, capped.height ?? 0) <= HIRING_SCAN_MAX_EDGE_PX,
      "a 12-megapixel photograph must be capped on its long edge before it is stored",
    );

    const small = await sharp({
      create: { background: { b: 255, g: 255, r: 255 }, channels: 3, height: 300, width: 200 },
    })
      .jpeg()
      .toBuffer();
    const keptResult = await polishDocumentPhoto({ bytes: small, mimeType: "image/jpeg" });
    const kept = await sharp(keptResult.bytes).metadata();
    assert.equal(
      kept.width,
      200,
      "a small page must NOT be upscaled — inventing pixels makes a blurred serial number look confident",
    );
  }

  // ── Enhancement failing must not lose the page ──────────────────────────────
  // A JPEG sharp can decode but whose enhancement throws still has to end up embeddable. The only
  // thing that may refuse is bytes nothing can read, and the route rejects those on content type
  // long before they reach here.
  {
    const notAnImage = Buffer.from("this is a sentence, not a certificate", "utf8");
    await assert.rejects(
      () => polishDocumentPhoto({ bytes: notAnImage, mimeType: "application/pdf" }),
      /could not be read as an image/i,
      "bytes no decoder can read must fail HERE with a message, not later inside the PDF writer",
    );

    const empty = await polishDocumentPhoto({ bytes: Buffer.alloc(0), mimeType: "image/jpeg" });
    assert.equal(empty.polished, false, "an empty upload is handed back untouched, not thrown on");
  }

  // ── Pages become one A4 PDF ─────────────────────────────────────────────────
  // Three photographs of one certificate are ONE document. Filing them as three files makes
  // "is this complete?" unanswerable, which is the question the whole checklist exists to answer.
  {
    const pages = [await dimPage(), await dimPage(), await pageWithARedSeal()];
    const scan = await scanPagesToPdf({ pages: pages.map((bytes) => ({ bytes, mimeType: "image/jpeg" })) });

    assert.equal(scan.pageCount, 3, "three photographs must produce a three-page PDF");
    assert.equal(scan.polishedPages, 3, "every page in a scan is polished");

    const pdf = await PDFDocument.load(scan.bytes);
    assert.equal(pdf.getPageCount(), 3, "the assembled PDF must really carry three pages");

    const first = pdf.getPage(0).getSize();
    assert.ok(
      Math.abs(first.width - 595.28) < 1 && Math.abs(first.height - 841.89) < 1,
      `a portrait page must be exactly A4 so it prints and files like every other document; got ` +
        `${first.width.toFixed(1)} x ${first.height.toFixed(1)}`,
    );
  }

  // ── A wide page gets a landscape sheet ──────────────────────────────────────
  // An ID card forced onto portrait A4 shrinks to a strip across the middle of the sheet.
  {
    const wide = await sharp({
      create: { background: { b: 250, g: 250, r: 250 }, channels: 3, height: 500, width: 1000 },
    })
      .jpeg()
      .toBuffer();

    const scan = await scanPagesToPdf({ pages: [{ bytes: wide, mimeType: "image/jpeg" }] });
    const pdf = await PDFDocument.load(scan.bytes);
    const size = pdf.getPage(0).getSize();

    assert.ok(
      size.width > size.height,
      `a photograph wider than it is tall must get a landscape A4 sheet; got ${size.width.toFixed(1)} x ${size.height.toFixed(1)}`,
    );
    assert.ok(
      Math.abs(size.width - 841.89) < 1 && Math.abs(size.height - 595.28) < 1,
      "landscape must still be A4, just turned — not an arbitrary rectangle",
    );
  }

  // ── An empty scan is refused, not silently saved as a blank PDF ─────────────
  {
    await assert.rejects(
      () => buildScannedDocumentPdf([]),
      /at least one page/i,
      "saving with no pages must say so, not file a zero-page PDF against a hiring document",
    );
  }

  // ── Scan modes ──────────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      [...HIRING_DOCUMENT_SCAN_MODES],
      ["colour", "greyscale", "high-contrast"],
      "the scan modes offered in the UI and accepted by the route must be the same three",
    );
    assert.equal(isHiringDocumentScanMode("colour"), true);
    assert.equal(isHiringDocumentScanMode("sepia"), false, "an unknown mode must not be accepted from a form field");
    assert.equal(isHiringDocumentScanMode(null), false);
  }

  // ── Storage paths ───────────────────────────────────────────────────────────
  // The random segment is what stops the second photograph of a two-sided national ID — arriving
  // as IMG_0042.jpg from the same phone — from overwriting the first.
  {
    const path = buildHiringDocumentFilePath({
      documentId: "11111111-2222-3333-4444-555555555555",
      employeeHrId: "B-154",
      fileName: "IMG_0042.jpg",
      uniqueSuffix: "abc123",
    });
    assert.equal(path, "B-154/11111111-2222-3333-4444-555555555555/abc123-IMG_0042.jpg");

    const first = buildHiringDocumentFilePath({ documentId: "d", employeeHrId: "B-154", fileName: "IMG_0042.jpg" });
    const second = buildHiringDocumentFilePath({ documentId: "d", employeeHrId: "B-154", fileName: "IMG_0042.jpg" });
    assert.notEqual(
      first,
      second,
      "TWO FILES WITH ONE NAME MUST NOT COLLIDE: a national ID is photographed twice and both arrive " +
        "as IMG_0042.jpg — sharing a path would lose the first side",
    );

    const arabic = buildHiringDocumentFilePath({
      documentId: "d",
      employeeHrId: "B-154",
      fileName: "شهادة الميلاد.pdf",
      uniqueSuffix: "u1",
    });
    assert.ok(
      /^B-154\/d\/u1-[A-Za-z0-9._-]+$/.test(arabic),
      `an Arabic file name must sanitize to a storage-safe segment, not produce a broken key; got ${arabic}`,
    );
  }

  // ── The upload gate ─────────────────────────────────────────────────────────
  {
    assert.equal(HIRING_DOCUMENTS_BUCKET, "hiring-documents");
    assert.equal(
      HIRING_DOCUMENT_MAX_UPLOAD_BYTES,
      15 * 1024 * 1024,
      "the code's size cap must match the bucket's file_size_limit in the migration, or the bucket " +
        "refuses with a message no user can act on",
    );

    assert.throws(
      () => assertHiringDocumentFileAllowed({ contentType: "image/jpeg", size: 0 }),
      /empty/i,
      "an empty file must be refused before it reaches storage",
    );
    assert.throws(
      () => assertHiringDocumentFileAllowed({ contentType: "image/jpeg", size: HIRING_DOCUMENT_MAX_UPLOAD_BYTES + 1 }),
      /15 MB/,
      "an oversized file must be refused with the actual limit in the message",
    );
    assert.throws(
      () => assertHiringDocumentFileAllowed({ contentType: "application/vnd.ms-excel", size: 1024 }),
      /PDF, JPG, PNG or WEBP/,
      "a spreadsheet must never be filed as a hiring document",
    );

    for (const contentType of HIRING_DOCUMENT_ALLOWED_CONTENT_TYPES) {
      assert.doesNotThrow(
        () => assertHiringDocumentFileAllowed({ contentType, size: 1024 }),
        `${contentType} is in the bucket's allowed list, so the code gate must accept it too`,
      );
    }

    assert.doesNotThrow(
      () => assertHiringDocumentFileAllowed({ contentType: "IMAGE/JPEG", size: 1024 }),
      "a browser that reports the MIME type in upper case must not be refused",
    );
  }
}
