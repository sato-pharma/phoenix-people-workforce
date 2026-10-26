// Recruitment / ATS — one applicant's application as a single PDF: the CV exactly as it was sent, then
// the application sheet (src/lib/recruitment/whatsapp-application-sheet.ts) on one A4 page.
//
// ONE FILE FOR BOTH BUTTONS. "Download application" saves this PDF and "Print application" prints it
// (through the print page, which draws its pages), so what is printed and what is saved cannot differ.
//
// THE CV IS NEVER REDRAWN WHEN IT IS ALREADY A PDF. Its pages are copied across untouched, which is the
// owner's "the CV as she sent it": same fonts, same layout, same page sizes. 532 of the 577 primary CVs
// on the page on 2026-09-19 were PDFs. The rest are handled by what they are:
//
//   PHOTO (6)   Straightened by its own orientation tag (a phone photo is often stored sideways), put
//               on an A4 page at its own aspect. Nothing is cropped.
//   WORD (39)   NOT as sent, and the sheet says so. There is no Word renderer in the container (no
//               LibreOffice), so the text and pictures are converted to HTML and drawn by Chromium.
//               Headings, lists, tables and pictures survive; exact fonts, columns and text boxes do not.
//               The sheet's footer names the CV as "converted", so nobody takes it for the original.
//   OTHER       An old-format .doc, a password-protected PDF, a file that will not open, a CV stored only
//               as a link, or none at all: the application prints without CV pages, and the footer says
//               why. A missing CV never stops the application sheet from being made.
//
// CHROMIUM DRAWS THE SHEET, not pdf-lib, because the sheet holds Arabic: pdf-lib's standard fonts have
// no Arabic glyphs and it does no shaping, so an answer typed in Arabic would print as blanks. Chromium
// shapes it and the container carries the Noto Arabic faces.
//
// THE CV IS SIZED BEFORE ANYTHING OPENS IT (audit, 2026-10-26, point 34). pdf-lib, mammoth and sharp run
// here, inside the web process, on a file a stranger sent. A CV over the inbound intake's own byte limit
// (maxInboundCvBytes, 15 MB — intake never takes a bigger one) is left out before any of them runs, and so
// is a PDF whose page objects already count past MAX_APPLICATION_CV_PAGES. A PDF that keeps its pages in
// compressed object streams is counted again once pdf-lib has opened it, and a Word file once Chromium has
// drawn it — both BEFORE a page is copied. Either way the application sheet is still made, and its footer
// says why the CV is missing.

import { PDFDocument } from "pdf-lib";
import * as mammoth from "mammoth";

import { satoLogoDataUri } from "@/lib/offers/brand";
import { withChromiumPage, type ChromiumPage } from "@/lib/pdf/chromium";
import { detectCvFileKind, isLegacyDocBytes } from "@/lib/recruitment/cv-file-kind";
import { maxInboundCvBytes } from "@/lib/recruitment/inbound/cv-intake-service";
import {
  buildApplicationSheet,
  buildApplicationSheetHtml,
  FIT_TO_ONE_PAGE_SCRIPT,
} from "@/lib/recruitment/whatsapp-application-sheet";
import type { WhatsAppApplication } from "@/lib/recruitment/whatsapp-applicants-loader";

export type ApplicationCvSource = { bytes: Uint8Array; fileName: string; mimeType: string };

/** What the CV contributes: pages to put first, and one sentence for the sheet's footer. */
type CvPart = { pdf: PDFDocument | null; line: string };

const A4_SHORT = 595.28;
const A4_LONG = 841.89;
const OPEN_FROM_PAGE = "Open it from the candidate's page.";

/** The most CV pages an application carries. A CV is a few pages; a file past this is not printed whole. */
export const MAX_APPLICATION_CV_PAGES = 50;

function pages(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function tooManyPages(count: number): string {
  return `CV not included: it has ${pages(count)}, more than the ${MAX_APPLICATION_CV_PAGES} an application prints. ${OPEN_FROM_PAGE}`;
}

/**
 * Page objects written in the open (`/Type /Page`, never `/Pages`). It reads the raw bytes without
 * parsing them, so it is cheap enough to run before pdf-lib; a PDF that keeps its page objects in
 * compressed object streams counts low here and is counted properly once it has been opened.
 */
export function countPlainPdfPageObjects(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

/**
 * Why this CV is left out before pdf-lib, mammoth or sharp opens it — or null when it may be opened.
 * The byte limit is the inbound intake's own (maxInboundCvBytes), never a second number.
 */
export function cvRefusedBeforeOpening(cv: ApplicationCvSource): string | null {
  const limit = maxInboundCvBytes();
  if (cv.bytes.byteLength > limit) {
    return `CV not included: the file is ${megabytes(cv.bytes.byteLength)}, over the ${megabytes(limit)} a CV may be. ${OPEN_FROM_PAGE}`;
  }
  if (detectCvFileKind(cv.mimeType, cv.fileName) === "pdf") {
    const plainPages = countPlainPdfPageObjects(cv.bytes);
    if (plainPages > MAX_APPLICATION_CV_PAGES) return tooManyPages(plainPages);
  }
  return null;
}

/** A PDF CV's pages, untouched, or the footer line that says why they are not there. */
export async function pdfCv(bytes: Uint8Array): Promise<CvPart> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { line: `CV not included: the PDF could not be read. ${OPEN_FROM_PAGE}`, pdf: null };
  }
  // A protected PDF loads without an error and then copies its pages across still scrambled, which
  // prints as blank or garbage. Better to say it is missing than to print a page that looks like a CV.
  if (doc.isEncrypted) {
    return { line: `CV not included: the PDF is password-protected. ${OPEN_FROM_PAGE}`, pdf: null };
  }
  const count = doc.getPageCount();
  if (count === 0) return { line: `CV not included: the PDF has no pages. ${OPEN_FROM_PAGE}`, pdf: null };
  if (count > MAX_APPLICATION_CV_PAGES) return { line: tooManyPages(count), pdf: null };
  return { line: `CV: PDF, ${pages(count)}, exactly as sent.`, pdf: doc };
}

async function photoCv(bytes: Uint8Array): Promise<CvPart> {
  try {
    // Loaded on use, not at the top: sharp is a native library and only this branch needs it.
    const sharp = (await import("sharp")).default;
    const jpeg = await sharp(bytes, { failOn: "none" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ fit: "inside", height: 3508, width: 3508, withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    const doc = await PDFDocument.create();
    const image = await doc.embedJpg(jpeg);
    const landscape = image.width > image.height;
    const width = landscape ? A4_LONG : A4_SHORT;
    const height = landscape ? A4_SHORT : A4_LONG;
    const margin = 20;
    const scale = Math.min((width - margin * 2) / image.width, (height - margin * 2) / image.height);
    const drawn = { height: image.height * scale, width: image.width * scale };
    doc.addPage([width, height]).drawImage(image, {
      height: drawn.height,
      width: drawn.width,
      x: (width - drawn.width) / 2,
      y: (height - drawn.height) / 2,
    });
    return { line: "CV: photo, exactly as sent.", pdf: doc };
  } catch {
    return { line: `CV not included: the photo could not be read. ${OPEN_FROM_PAGE}`, pdf: null };
  }
}

/**
 * A Word file's text as a printable page. `unicode-bidi: plaintext` gives every paragraph the direction
 * its own first letter says, so an Arabic CV and an English one both read the right way round. The CSP
 * meta is there because the markup came out of somebody else's file: nothing in it may run or load.
 */
function wordHtml(body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  @page { size: A4 portrait; margin: 15mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111; font-family: "Segoe UI", Tahoma, Arial, "Noto Sans Arabic", "Noto Naskh Arabic", sans-serif; font-size: 10.5pt; line-height: 1.4; }
  p, li, td, th, h1, h2, h3, h4, h5, h6 { unicode-bidi: plaintext; text-align: start; overflow-wrap: anywhere; }
  p { margin: 0 0 5pt; }
  h1, h2, h3, h4, h5, h6 { margin: 9pt 0 4pt; }
  img { max-width: 100%; height: auto; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 2pt 4pt; border: .5pt solid #999; vertical-align: top; }
</style></head>
<body>${body}</body></html>`;
}

async function wordCv(bytes: Uint8Array, page: ChromiumPage): Promise<CvPart> {
  if (isLegacyDocBytes(bytes)) {
    return {
      line: `CV not included: it is an old-format Word file (.doc), which cannot be converted for printing. ${OPEN_FROM_PAGE}`,
      pdf: null,
    };
  }
  try {
    const converted = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    await page.setContent(wordHtml(converted.value), { timeout: 30_000, waitUntil: "load" });
    await page.emulateMediaType("print");
    const drawn = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
    const doc = await PDFDocument.load(drawn);
    if (doc.getPageCount() > MAX_APPLICATION_CV_PAGES) return { line: tooManyPages(doc.getPageCount()), pdf: null };
    return {
      line: `CV: Word file, converted for printing (${pages(doc.getPageCount())}). Fonts and layout differ from the original, which is on the candidate's page.`,
      pdf: doc,
    };
  } catch {
    return { line: `CV not included: the Word file could not be converted. ${OPEN_FROM_PAGE}`, pdf: null };
  }
}

async function cvPart(cv: ApplicationCvSource | null, missingReason: string, page: ChromiumPage): Promise<CvPart> {
  if (!cv) return { line: `CV not included: ${missingReason}`, pdf: null };
  // Before pdf-lib, mammoth or sharp sees a byte of it.
  const refused = cvRefusedBeforeOpening(cv);
  if (refused) return { line: refused, pdf: null };
  switch (detectCvFileKind(cv.mimeType, cv.fileName)) {
    case "pdf":
      return pdfCv(cv.bytes);
    case "image":
      return photoCv(cv.bytes);
    case "docx":
      return wordCv(cv.bytes, page);
    default:
      return { line: `CV not included: this kind of file cannot be printed here. ${OPEN_FROM_PAGE}`, pdf: null };
  }
}

export type BuiltApplicationPdf = {
  bytes: Uint8Array;
  /** How many CV pages come first. Zero when the CV could not be included. */
  cvPages: number;
  /** The sheet's own pages. One, unless an answer was too long to shrink onto it. */
  sheetPages: number;
};

/**
 * The application as one PDF. `missingCvReason` finishes "CV not included: ..." when there is no file
 * to include, and is the only thing that reads as a reason, so it says what was found.
 */
export async function buildWhatsAppApplicationPdf(input: {
  application: WhatsAppApplication;
  cv: ApplicationCvSource | null;
  missingCvReason: string;
  now?: Date;
  /**
   * Did this person apply on WhatsApp? Defaults true (every existing caller). False for the screening
   * page's "Download application" on a candidate who never used WhatsApp — the sheet is then a plain Job
   * application form with no Q&A section, and the file names itself accordingly.
   */
  hasWhatsApp?: boolean;
}): Promise<BuiltApplicationPdf> {
  const { application, cv, missingCvReason } = input;
  const hasWhatsApp = input.hasWhatsApp ?? true;
  return withChromiumPage(async (page) => {
    // The CV first: a Word CV needs this same browser, and the sheet's footer needs to know what
    // became of it.
    const part = await cvPart(cv, missingCvReason, page);

    const sheet = buildApplicationSheet({
      candidate: application.candidate,
      contact: application.contact,
      cvLine: part.line,
      hasWhatsApp,
      now: input.now ?? new Date(),
      row: application.row,
      titleLabel: application.titleLabel,
    });
    // "load", not "domcontentloaded": the fit below measures the body against what is left under the
    // letterhead, so the mark has to have its size before anything is measured.
    await page.setContent(buildApplicationSheetHtml(sheet, satoLogoDataUri()), { timeout: 30_000, waitUntil: "load" });
    await page.emulateMediaType("print");
    await page.evaluate(FIT_TO_ONE_PAGE_SCRIPT);
    const drawn = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });

    const sheetDoc = await PDFDocument.load(drawn);
    const merged = await PDFDocument.create();
    if (part.pdf) {
      for (const copied of await merged.copyPages(part.pdf, part.pdf.getPageIndices())) merged.addPage(copied);
    }
    for (const copied of await merged.copyPages(sheetDoc, sheetDoc.getPageIndices())) merged.addPage(copied);
    merged.setTitle(`${application.row.name} — ${hasWhatsApp ? "WhatsApp application" : "Job application"}`);
    merged.setCreator("Phoenix Workforce");
    merged.setProducer("Phoenix Workforce");
    return {
      bytes: await merged.save(),
      cvPages: part.pdf ? part.pdf.getPageCount() : 0,
      sheetPages: sheetDoc.getPageCount(),
    };
  });
}
