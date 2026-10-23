// Recruitment / ATS — reading a SCANNED CV with no AI and no vendor.
//
// About 5% of the careers inbox arrives as a photograph: a CV printed, photographed on a phone, and
// wrapped in a PDF, or sent straight through as a .jpg. Those pages carry no text layer at all, so
// the rule engine has nothing to read and they route to the vision model. This module gives them a
// free first attempt.
//
// WHAT IT IS AND IS NOT. Tesseract is genuinely good on a clean printed page and genuinely bad on a
// creased phone photo of one, and it reads only the language it was given. Measured over the six
// scanned CVs in the inbox on 2026-08-19:
//
//   confidence 91  Nermeen Adel       name, e-mail, BOTH mobiles, city — complete
//   confidence 91  Peter Nashaat      name, street address, both mobiles, e-mail, LinkedIn, degree
//   confidence 78  Sherif Fathy       readable through heavy decorative noise
//   confidence 75  Ashraf Zaki        readable, noisy
//   confidence 41  (Arabic document)  unreadable — the English model cannot read Arabic
//   confidence 32  (Arabic document)  unreadable
//
// The four names are INVENTED — they were the real applicants' until 2026-08-28. The measurement
// is the point of this table and is unchanged.
//
// So it solves four of the six and is worthless on the other two, and — this is the useful part —
// Tesseract's own confidence separates the two groups cleanly, with nothing between 41 and 75. That
// is why this module is allowed to REFUSE. Below the threshold it returns null and the caller goes
// to the model exactly as it does today, so OCR can only ever save a call, never cost an applicant
// their profile.
//
// ENGLISH ONLY, deliberately. Arabic Tesseract data is another 5 MB for a script the engine reads
// poorly, on documents the vision model already handles well. The two Arabic scans fall through, by
// design, and the confidence gate is what makes that automatic rather than a guess.
//
// NO NETWORK. tesseract.js downloads its language data from a CDN by default and writes it into the
// process's working directory — a third-party fetch from a production server, on a cold start, into
// the app directory. The data file is vendored at assets/tessdata/eng.traineddata.gz (2.9 MB)
// instead and cacheMethod is "none", so this module never reaches the network. tesseract.js expects
// the file at langPath GZIPPED and named exactly "<lang>.traineddata.gz"; handed the uncompressed
// file it reports ENOENT for the .gz that is not there.

import path from "node:path";

import { logError } from "@/lib/observability/log";

/**
 * Tesseract's mean per-word confidence, 0-100, below which the read is discarded.
 *
 * 60 sits in the empty band between the two populations measured above (41 and 75 are the nearest
 * points on either side), so it is not a knob tuned to a hoped-for outcome — there is simply nothing
 * in this corpus between a read that worked and one that did not.
 */
export const OCR_MIN_CONFIDENCE = 60;

/**
 * How many letters and digits a read must produce to count as a page of text. Same threshold as
 * cv-text-layer.ts uses on a PDF's native text layer, for the same reason: below it there is not
 * enough to identify anybody.
 */
export const OCR_MIN_READABLE_CHARS = 200;

/**
 * Pages to read. A CV is one or two; three is generous. Each page costs 2-5 seconds of CPU, so this
 * is the bound that keeps a 30-page scanned document from occupying the server.
 */
const MAX_OCR_PAGES = 3;

/** Downscale ceiling. Tesseract gains nothing above ~2,000px on the long edge and slows down. */
const MAX_OCR_EDGE_PX = 2_000;

const TESSDATA_DIR = path.join(process.cwd(), "assets", "tessdata");

/**
 * The two members of tesseract.js's worker this module touches.
 *
 * Declared here rather than imported: tesseract.js is in serverExternalPackages and is loaded by
 * dynamic import, and naming the shape we actually use keeps the surface honest — recognize a page,
 * then always terminate.
 */
type OcrWorker = {
  recognize: (image: Buffer) => Promise<{ data: { text?: string; confidence?: number } }>;
  terminate: () => Promise<unknown>;
};

export type OcrResult = {
  readonly text: string;
  /** Tesseract's mean confidence, 0-100. */
  readonly confidence: number;
  readonly pages: number;
};

function readableChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/**
 * The page images inside a scanned PDF.
 *
 * Extracts the EMBEDDED images rather than rendering the pages: every scanned CV in the corpus is
 * exactly one embedded image per page, which is what a phone photo wrapped in a PDF always looks
 * like, so extraction gets the same pixels for a fraction of the work.
 *
 * It does NOT, however, avoid the canvas. This comment used to claim exactly that — that the native
 * @napi-rs/canvas dependency was sidestepped because nothing is rendered — and it was wrong:
 * pdf-parse builds a canvas to DECODE an embedded image too (di._createCanvas). Next's production
 * file-tracer does not copy that native addon on its own, so this function threw "Cannot find
 * module '@napi-rs/canvas'" on every scanned PDF in production from the day it shipped — silently,
 * because the caller below turns any failure into a null and falls back to the model. The addon is
 * traced explicitly now; see the outputFileTracingIncludes note in next.config.ts, and keep those
 * entries in step if this file ever moves.
 */
async function pdfPageImages(bytes: Buffer): Promise<Buffer[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getImage({});
    const images: Buffer[] = [];
    for (const page of result.pages ?? []) {
      const first = page.images?.[0];
      const dataUrl = first?.dataUrl;
      if (typeof dataUrl === "string" && dataUrl.includes(",")) {
        images.push(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
      }
      if (images.length >= MAX_OCR_PAGES) break;
    }
    return images;
  } finally {
    await parser.destroy();
  }
}

/**
 * Grayscale, contrast-normalize and bound the size.
 *
 * Not decoration: a phone photo of a printed page is a colour image with uneven lighting, and
 * Tesseract is a binarizer at heart. This is the cheap preprocessing that moves such a page from
 * unreadable to readable, and sharp is already a dependency of this app.
 */
async function prepareForOcr(image: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(image)
    .rotate() // honour the EXIF orientation a phone camera writes, or the page is read sideways
    .resize({ fit: "inside", height: MAX_OCR_EDGE_PX, width: MAX_OCR_EDGE_PX, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();
}

/**
 * The whole read's deadline — PDF image extraction, Tesseract start-up and every page together.
 *
 * WHY (23 Oct 2026 audit, P5-04). MAX_OCR_PAGES bounded the pages but not the time: a pathological
 * image could keep Tesseract (and the request that started it) busy indefinitely on the process that
 * also serves payroll. Three pages measure 2-5 seconds each, so a minute is generous for a real CV;
 * past it the worker is terminated and the caller goes to the model exactly as on any other failure.
 */
export const OCR_DEADLINE_MS = 60_000;

/** Resolves `work`, or null once `timeoutMs` passes (calling `onTimeout` first). Never rejects on the timeout. */
export async function withOcrDeadline<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type OcrRun = { timedOut: boolean; worker: OcrWorker | null };

/**
 * Reads a scanned CV, or returns null.
 *
 * Null means "use the model" and is a perfectly normal outcome — an Arabic document, a bad
 * photograph, a PDF with no extractable image, a read past OCR_DEADLINE_MS, or any failure at all.
 * NOTHING in here is allowed to throw at the caller: this runs ahead of a path that already works,
 * so its worst case must be that it changes nothing.
 */
export async function extractTextByOcr(
  input: {
    bytes: Buffer;
    fileKind: "pdf" | "image";
    fileName: string;
  },
  options: { deadlineMs?: number } = {},
): Promise<OcrResult | null> {
  const run: OcrRun = { timedOut: false, worker: null };
  try {
    return await withOcrDeadline(readByOcr(input, run), options.deadlineMs ?? OCR_DEADLINE_MS, () => {
      run.timedOut = true;
      logError("Free OCR of a scanned CV ran past its deadline and was stopped; falling back to the vision model", {
        labels: { event: "cv_ocr_timed_out", file_name: input.fileName },
      });
    });
  } finally {
    // Always. A leaked Tesseract worker is a leaked child process holding ~200 MB, on a single
    // production replica that also serves payroll.
    if (run.worker) await run.worker.terminate().catch(() => undefined);
  }
}

async function readByOcr(input: { bytes: Buffer; fileKind: "pdf" | "image"; fileName: string }, run: OcrRun): Promise<OcrResult | null> {
  try {
    const images = input.fileKind === "pdf" ? await pdfPageImages(input.bytes) : [input.bytes];
    if (images.length === 0 || run.timedOut) return null;

    const { createWorker } = await import("tesseract.js");
    // langPath + cacheMethod "none" is what keeps this offline. Without both, tesseract.js fetches
    // eng.traineddata from a CDN and writes it into process.cwd() on every cold start.
    const active = (await createWorker("eng", undefined, {
      cacheMethod: "none",
      langPath: TESSDATA_DIR,
    })) as unknown as OcrWorker;
    if (run.timedOut) {
      // The deadline passed while the worker was starting: the caller's cleanup has already run.
      await active.terminate().catch(() => undefined);
      return null;
    }
    run.worker = active;

    const texts: string[] = [];
    const confidences: number[] = [];
    for (const image of images.slice(0, MAX_OCR_PAGES)) {
      if (run.timedOut) return null;
      const prepared = await prepareForOcr(image);
      const { data } = await active.recognize(prepared);
      const text = data.text ?? "";
      // A blank or near-blank page (a scanned back cover) must not drag the average down and veto
      // the pages that DID read.
      if (readableChars(text) < 40) continue;
      texts.push(text);
      confidences.push(data.confidence ?? 0);
    }

    if (texts.length === 0) return null;
    const text = texts.join("\n\n");
    const confidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;

    if (confidence < OCR_MIN_CONFIDENCE) return null;
    if (readableChars(text) < OCR_MIN_READABLE_CHARS) return null;
    return { confidence, pages: texts.length, text };
  } catch (error) {
    // After the deadline the worker is terminated under this read, which then fails — already logged.
    if (!run.timedOut) {
      logError("Free OCR of a scanned CV failed; falling back to the vision model", {
        error,
        labels: { event: "cv_ocr_failed", file_name: input.fileName },
      });
    }
    return null;
  }
}
