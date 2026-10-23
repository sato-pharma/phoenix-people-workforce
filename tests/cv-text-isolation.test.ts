import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { extractRawTextFromFile, extractRawTextInProcess } from "../src/lib/recruitment/cv-extraction.ts";
import {
  CV_PARSE_MAX_OLD_GENERATION_MB,
  CV_PARSE_TIMEOUT_MS,
  CvParseLimitError,
  extractCvTextIsolated,
  parseCvTextInWorker,
} from "../src/lib/recruitment/cv-text-isolation.ts";

/**
 * CV FILES FROM STRANGERS ARE PARSED IN A BOUNDED THREAD (23 Oct 2026 audit, P5-04).
 *
 * pdf-parse, mammoth and word-extractor ran inside the web process on files anyone can send, with no
 * bound on time or memory. They now run in a worker thread with a heap ceiling and a deadline. The
 * text a normal file yields is the SAME string the in-process reader gave — proven here on a real PDF
 * and a real .docx — and a thread that cannot load its library falls back to the in-process reader.
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

  // ── a thread that cannot load its library falls back in-process, never fails the CV ─────────────
  const missing = `require("node:worker_threads").parentPort.postMessage({ type: "unavailable", message: "Cannot find module 'pdf-parse'" });`;
  let fellBack = false;
  const text = await extractCvTextIsolated(pdf, "pdf", async () => {
    fellBack = true;
    return "in-process text";
  }, { workerSource: missing });
  assert.equal(fellBack, true);
  assert.equal(text, "in-process text");
  let limitFellBack = false;
  await assert.rejects(() =>
    extractCvTextIsolated(pdf, "pdf", async () => {
      limitFellBack = true;
      return "";
    }, { timeoutMs: 300, workerSource: spin }),
  );
  assert.equal(limitFellBack, false, "a file that broke a limit is refused — never retried in-process without one");

  // The production entry point routes PDF and Word through the thread and turns a limit into "unreadable".
  const extraction = readFileSync("src/lib/recruitment/cv-extraction.ts", "utf8");
  const entry = extraction.slice(extraction.indexOf("export async function extractRawTextFromFile("));
  assert.match(entry.slice(0, 1_200), /return await extractCvTextIsolated\(bytes, isolatedKind, \(\) => extractRawTextInProcess\(bytes, mimeType, fileName\)\);/);
  assert.match(entry.slice(0, 1_200), /if \(error instanceof CvParseLimitError\) throw new CvExtractionError\("unsupported_file", error\.message\);/);
}
