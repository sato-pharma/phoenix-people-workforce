import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { PDFParse } from "pdf-parse";
import sharp from "sharp";

import { CvExtractionError, extractRawTextFromFile, extractRawTextInProcess } from "../src/lib/recruitment/cv-extraction.ts";
import {
  CV_PARSE_MAX_OLD_GENERATION_MB,
  CV_PARSE_TIMEOUT_MS,
  CvParseIsolationUnavailableError,
  CvParseLimitError,
  extractCvTextIsolated,
  extractPdfPageImagesInWorker,
  parseCvTextInWorker,
} from "../src/lib/recruitment/cv-text-isolation.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * CV FILES FROM STRANGERS ARE PARSED IN A BOUNDED THREAD (23 Oct 2026 audit, P5-04).
 *
 * pdf-parse, mammoth and word-extractor ran inside the web process on files anyone can send, with no
 * bound on time or memory. They now run in a worker thread with a heap ceiling and a deadline. The
 * text a normal file yields is the SAME string the in-process reader gave — proven here on a real PDF
 * and a real .docx. A thread that cannot load its library is a REFUSAL — it used to fall back to the
 * in-process reader without limits (audit, 2026-10-26, point 33) — and the scanned-CV OCR's page-image
 * extraction runs in the same bounded thread instead of in the web process.
 */

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = ["Nermeen Adel", "Medical Representative", "nermeen.adel@example.org", "+20 100 000 0000", "Cairo, Egypt"];
  lines.forEach((line, index) => page.drawText(line, { font, size: 14, x: 50, y: 780 - index * 24 }));
  const second = doc.addPage([595, 842]);
  second.drawText("Experience: 4 years in CNS and Pedia lines", { font, size: 12, x: 50, y: 780 });
  return Buffer.from(await doc.save());
}

/** A "scanned" PDF: one embedded picture per page, the shape cv-ocr.ts reads. Four pages, distinct colours. */
async function sampleScannedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const colours = [
    { b: 30, g: 30, r: 200 },
    { b: 30, g: 200, r: 30 },
    { b: 200, g: 30, r: 30 },
    { b: 200, g: 200, r: 200 },
  ];
  for (const background of colours) {
    const png = await sharp({ create: { background, channels: 3, height: 300, width: 400 } }).png().toBuffer();
    const page = doc.addPage([595, 842]);
    page.drawImage(await doc.embedPng(png), { height: 300, width: 400, x: 50, y: 400 });
  }
  return Buffer.from(await doc.save());
}

/** cv-ocr.ts's own pre-2026-10-26 in-process extraction, kept here as the reference the thread must match. */
async function pageImagesInProcess(bytes: Buffer, maxPages: number): Promise<Buffer[]> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getImage({});
    const images: Buffer[] = [];
    for (const page of result.pages ?? []) {
      const dataUrl = page.images?.[0]?.dataUrl;
      if (typeof dataUrl === "string" && dataUrl.includes(",")) images.push(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
      if (images.length >= maxPages) break;
    }
    return images;
  } finally {
    await parser.destroy();
  }
}

async function sampleDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const paragraphs = ["Peter Nashaat", "District Manager", "peter.nashaat@example.org", "Alexandria"]
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

export async function runCvTextIsolationTests() {
  // Production's web process holds pdf-parse's CommonJS build: cv-extraction.ts imports it, and Next turns a
  // server-external package into a plain require(). This file's ESM import loads the OTHER build, and on
  // Windows a pdf-parse thread then segfaults on exit (exit 139, origin/main's own test, 3 runs in 4). Load
  // the build production loads, so the threads run under the same conditions they do on the server.
  createRequire(import.meta.url)("pdf-parse");
  assert.ok(CV_PARSE_TIMEOUT_MS <= 60_000, "the parse has a deadline");
  assert.ok(CV_PARSE_MAX_OLD_GENERATION_MB <= 512, "and a heap ceiling");

  // ── identical text for normal files ─────────────────────────────────────────────────────────────
  const pdf = await samplePdf();
  const pdfInProcess = await extractRawTextInProcess(pdf, "application/pdf", "cv.pdf");
  const pdfIsolated = await parseCvTextInWorker(pdf, "pdf");
  assert.match(pdfInProcess, /Nermeen Adel/, "the fixture has a text layer");
  assert.equal(pdfIsolated, pdfInProcess, "a PDF reads to the IDENTICAL string in the thread");
  assert.equal(await extractRawTextFromFile(pdf, "application/pdf", "cv.pdf"), pdfInProcess, "and through the production entry point");

  const docx = await sampleDocx();
  const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const docxInProcess = await extractRawTextInProcess(docx, docxType, "cv.docx");
  assert.match(docxInProcess, /Peter Nashaat/);
  assert.equal(await parseCvTextInWorker(docx, "docx"), docxInProcess, "a .docx reads to the IDENTICAL string in the thread");
  assert.equal(await extractRawTextFromFile(docx, docxType, "cv.docx"), docxInProcess);
  assert.ok(pdf.length > 0 && docx.length > 0, "the caller's buffers are untouched (copied, never transferred)");

  // ── the limits ──────────────────────────────────────────────────────────────────────────────────
  const spin = `require("node:worker_threads"); for (;;) {}`;
  await assert.rejects(
    () => parseCvTextInWorker(pdf, "pdf", { timeoutMs: 300, workerSource: spin }),
    (error: unknown) => error instanceof CvParseLimitError && error.limit === "timeout",
    "a parse that never finishes is stopped at its deadline",
  );
  const hog = `const keep = []; for (;;) { keep.push(new Array(1e6).fill(keep.length)); }`;
  await assert.rejects(
    () => parseCvTextInWorker(pdf, "pdf", { maxOldGenerationSizeMb: 32, timeoutMs: 30_000, workerSource: hog }),
    (error: unknown) => error instanceof CvParseLimitError && error.limit === "memory",
    "a parse that eats memory is killed at its ceiling — the web process carries on",
  );
  const library = `require("node:worker_threads").parentPort.postMessage({ type: "error", message: "Invalid PDF structure" });`;
  await assert.rejects(
    () => parseCvTextInWorker(pdf, "pdf", { workerSource: library }),
    (error: unknown) => error instanceof Error && !(error instanceof CvParseLimitError) && /Invalid PDF structure/.test(error.message),
    "a library's own error comes back as itself",
  );

  // ── a thread that cannot load its library is REFUSED, never read in-process (point 33) ──────────
  // It used to fall back to the in-process reader — the unbounded parse the thread exists to stop —
  // and on 23 Oct 2026 every PDF and legacy .doc on production took that fallback.
  const missing = `require("node:worker_threads").parentPort.postMessage({ type: "unavailable", message: "Cannot find module 'pdf-parse'" });`;
  await assert.rejects(
    () => extractCvTextIsolated(pdf, "pdf", { workerSource: missing }),
    (error: unknown) => error instanceof CvParseIsolationUnavailableError,
    "a thread that cannot load its library must REFUSE the file — it must never read it in-process without the limits",
  );
  await assert.rejects(
    () => extractCvTextIsolated(pdf, "pdf", { timeoutMs: 300, workerSource: spin }),
    (error: unknown) => error instanceof CvParseLimitError,
    "a file that broke a limit is refused — never retried in-process without one",
  );
  // Through the production entry point the refusal is a failed read the recruiter can retry: "ai_failed"
  // (answered 502 by the re-read route), never "unsupported_file", which would call the FILE bad.
  await assert.rejects(
    () => extractRawTextFromFile(pdf, "application/pdf", "cv.pdf", { workerSource: missing }),
    (error: unknown) => error instanceof CvExtractionError && error.code === "ai_failed",
    'the CV entry point must answer a thread that cannot start with CvExtractionError("ai_failed") — not with the in-process text',
  );
  await assert.rejects(
    () => extractRawTextFromFile(docx, docxType, "cv.docx", { timeoutMs: 300, workerSource: spin }),
    (error: unknown) => error instanceof CvExtractionError && error.code === "unsupported_file",
    "a file past a limit is still answered as unreadable",
  );

  // The production entry point routes PDF and Word through the thread and turns a limit into "unreadable".
  const extraction = stripComments(readFileSync("src/lib/recruitment/cv-extraction.ts", "utf8"));
  const entry = extraction.slice(extraction.indexOf("export async function extractRawTextFromFile("));
  const entryBody = entry.slice(0, entry.indexOf("\n}\n"));
  assert.match(entryBody, /return await extractCvTextIsolated\(bytes, isolatedKind, isolation\);/);
  assert.match(entryBody, /if \(error instanceof CvParseLimitError\) throw new CvExtractionError\("unsupported_file", error\.message\);/);
  assert.equal(
    (entryBody.match(/extractRawTextInProcess\(/g) ?? []).length,
    1,
    "the entry point calls the in-process reader ONLY for a kind the thread does not read (to throw unsupported_file) — never as a fallback",
  );

  // ── the scanned-CV OCR's page images come out of the SAME bounded thread (point 33) ────────────
  const scanned = await sampleScannedPdf();
  const reference = await pageImagesInProcess(scanned, 3);
  const isolatedImages = await extractPdfPageImagesInWorker(scanned, 3);
  assert.equal(reference.length, 3, "the fixture yields one image per page, capped at three");
  assert.equal(isolatedImages.length, 3, "the thread caps the pages exactly as cv-ocr.ts did");
  // The PNG pdf-parse re-encodes can differ byte for byte between its ESM and CommonJS builds; what OCR
  // sends on is the picture, so the pictures must match pixel for pixel.
  for (const [index, image] of isolatedImages.entries()) {
    const thread = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    const inProcess = await sharp(reference[index]).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(thread.info, inProcess.info, "page " + (index + 1) + " image has the same size and channels as the in-process extraction");
    assert.ok(thread.data.equals(inProcess.data), "page " + (index + 1) + " image is pixel-identical to the in-process extraction");
  }
  const firstPixels = await Promise.all(isolatedImages.map(async (image) => [...(await sharp(image).raw().toBuffer()).subarray(0, 3)].join(",")));
  assert.deepEqual(firstPixels, ["200,30,30", "30,200,30", "30,30,200"], "the thread returns pages one, two and three, in order");
  assert.equal((await extractPdfPageImagesInWorker(pdf, 3)).length, 0, "a PDF with no embedded image yields none");
  await assert.rejects(
    () => extractPdfPageImagesInWorker(scanned, 3, { workerSource: missing }),
    (error: unknown) => error instanceof CvParseIsolationUnavailableError,
    "an image read whose thread cannot start is refused, never run in-process",
  );
  await assert.rejects(
    () => extractPdfPageImagesInWorker(scanned, 3, { timeoutMs: 300, workerSource: spin }),
    (error: unknown) => error instanceof CvParseLimitError && error.limit === "timeout",
    "an image read is held to the same deadline",
  );
  const ocrSource = stripComments(readFileSync("src/lib/recruitment/cv-ocr.ts", "utf8"));
  assert.ok(
    !/["']pdf-parse["']/.test(ocrSource) && !/PDFParse|getImage\(/.test(ocrSource),
    "cv-ocr.ts must not load pdf-parse or call getImage() in the web process — the page images come from the bounded thread",
  );
  assert.match(ocrSource, /extractPdfPageImagesInWorker\(bytes, MAX_OCR_PAGES\)/, "cv-ocr.ts reads its page images through extractPdfPageImagesInWorker");

  // 🔴 EVERY LIBRARY THE THREAD require()s MUST BE A NEXT SERVER-EXTERNAL PACKAGE (audit follow-up, 2026-10-23).
  // The thread loads its library by name from node_modules at run time. Next's production file tracing keeps a
  // package on disk for that only when it is external; a package left out of serverExternalPackages is bundled
  // into the route, so the thread answers "unavailable" and the file is read in-process WITHOUT the 384 MB and
  // 30 s limits. word-extractor was the one left out, so a legacy .doc skipped the isolation on production.
  {
    const isolation = readFileSync("src/lib/recruitment/cv-text-isolation.ts", "utf8");
    const threadLibs = [...isolation.matchAll(/require\("([^".][^"]*)"\)/g)]
      .map((m) => m[1])
      .filter((name) => !name.startsWith("node:") && name !== "dommatrix");
    assert.deepEqual(
      [...new Set(threadLibs)].sort(),
      ["mammoth", "pdf-parse", "word-extractor"],
      "the thread loads exactly pdf-parse, mammoth and word-extractor",
    );
    const config = readFileSync("next.config.ts", "utf8");
    const externals = /serverExternalPackages:\s*\[([^\]]*)/.exec(config)?.[1] ?? "";
    // The traced-include list: a file under a package's top-level path makes Next link node_modules/<name> in the
    // standalone image, which is the only place a bare require() from the thread can find it (production, 23 Oct
    // 2026: node_modules/mammoth and node_modules/word-extractor were linked, node_modules/pdf-parse was NOT).
    const includes = /outputFileTracingIncludes:\s*\{([\s\S]*?)\n  \},/.exec(config)?.[1] ?? "";
    for (const name of new Set(threadLibs)) {
      assert.ok(
        externals.includes(`"${name}"`),
        `next.config.ts serverExternalPackages must list "${name}" — the isolated CV thread require()s it, and a bundled package is read in-process without limits`,
      );
      assert.ok(
        includes.includes(`"./node_modules/${name}/**"`),
        `next.config.ts outputFileTracingIncludes must list "./node_modules/${name}/**" — without it the production image has no node_modules/${name} for the thread to require() and the file is read in-process without limits`,
      );
    }
  }
}
