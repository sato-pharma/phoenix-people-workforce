// Reads the text out of a CV file in a WORKER THREAD with a memory ceiling and a deadline.
//
// WHY (23 Oct 2026 audit, P5-04). CV files arrive from anonymous senders — the public careers form,
// the careers mailbox, WhatsApp — and were parsed by pdf-parse, mammoth and word-extractor INSIDE the
// web process, with no bound on time or memory. One crafted (or simply pathological) file could hold
// the event loop or exhaust the heap of the process that also answers every page and runs payroll.
// Now the parse runs in its own thread: past CV_PARSE_MAX_OLD_GENERATION_MB the thread is killed by
// V8, past CV_PARSE_TIMEOUT_MS it is terminated, and either way the web process carries on and the
// caller gets a clear error instead of a hang.
//
// THE TEXT IS THE SAME. The thread runs the same three libraries with the same options as the
// in-process path in cv-extraction.ts (`getText({ parseHyperlinks: true })`, `extractRawText`,
// `WordExtractor().extract().getBody()`), so a normal file reads to the identical string — pinned by
// tests/cv-text-isolation.test.ts against real PDF and Word files.
//
// A THREAD THAT CANNOT START IS A REFUSAL, NEVER AN IN-PROCESS READ (audit, 2026-10-26, point 33).
// This used to fall back to the in-process reader whenever the thread could not LOAD its library (a
// production image whose file tracing left a package out), "so it could never be worse than before".
// It could: that fallback is the unbounded parse this file exists to stop, and on 23 Oct 2026 every
// PDF and every legacy .doc on production took it, because node_modules/pdf-parse and word-extractor
// were not in the image. Now the read is refused with CvParseIsolationUnavailableError (logged once
// per process as cv_parse_isolation_unavailable) and cv-extraction.ts answers it as a failed read the
// recruiter can retry; the intake still creates the applicant with their file. next.config.ts keeps
// the three packages in the image, pinned by tests/cv-text-isolation.test.ts.
//
// THE SCANNED-CV OCR READS ITS PAGE IMAGES HERE TOO. cv-ocr.ts pulled the embedded page images out of
// a PDF with pdf-parse's getImage() INSIDE the web process — the same library, on the same files from
// strangers, with no ceiling (point 33). extractPdfPageImagesInWorker runs that call in this thread,
// under the same heap ceiling and deadline.

import { Worker } from "node:worker_threads";

import { logError } from "@/lib/observability/log";

export const CV_PARSE_TIMEOUT_MS = 30_000;
export const CV_PARSE_MAX_OLD_GENERATION_MB = 384;
export const CV_PARSE_MAX_YOUNG_GENERATION_MB = 64;

export type IsolatedCvParseKind = "pdf" | "docx" | "doc";
type IsolatedWorkerKind = IsolatedCvParseKind | "pdf-images";

/** A parse that started and broke a limit. The file is refused, never retried in-process. */
export class CvParseLimitError extends Error {
  readonly limit: "memory" | "timeout" | "crashed";

  constructor(limit: "memory" | "timeout" | "crashed", message: string) {
    super(message);
    this.name = "CvParseLimitError";
    this.limit = limit;
  }
}

// Plain CommonJS, evaluated in the thread. It must stay self-contained: it cannot import this repo's
// TypeScript (the DOMMatrix polyfill is therefore repeated here, from the same `dommatrix` package
// pdf-dommatrix-polyfill.ts uses). "pdf-images" is cv-ocr.ts's getImage() call, unchanged: the first
// embedded image of each page, at most workerData.maxPages of them, sent back as base64.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  let lib;
  if (typeof globalThis.DOMMatrix === "undefined") {
    // Optional: where the shim is not on disk, pdfjs can still take DOMMatrix from @napi-rs/canvas,
    // and if neither is there pdf-parse fails to load just below and the read is refused.
    try {
      const matrix = require("dommatrix");
      globalThis.DOMMatrix = matrix && matrix.default ? matrix.default : matrix;
    } catch {}
  }
  try {
    lib = workerData.kind === "pdf" || workerData.kind === "pdf-images" ? require("pdf-parse") : workerData.kind === "doc" ? require("word-extractor") : require("mammoth");
  } catch (error) {
    parentPort.postMessage({ type: "unavailable", message: String((error && error.message) || error) });
    return;
  }
  try {
    const source = workerData.bytes;
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    let text;
    if (workerData.kind === "pdf-images") {
      const parser = new lib.PDFParse({ data: bytes });
      const images = [];
      try {
        const result = await parser.getImage({});
        for (const page of (result && result.pages) || []) {
          const first = page && page.images && page.images[0];
          const dataUrl = first && first.dataUrl;
          if (typeof dataUrl === "string" && dataUrl.includes(",")) images.push(dataUrl.slice(dataUrl.indexOf(",") + 1));
          if (images.length >= workerData.maxPages) break;
        }
      } finally {
        await parser.destroy();
      }
      parentPort.postMessage({ type: "images", images });
      return;
    }
    if (workerData.kind === "pdf") {
      const parser = new lib.PDFParse({ data: bytes });
      try {
        const result = await parser.getText({ parseHyperlinks: true });
        text = (result && result.text) || "";
      } finally {
        await parser.destroy();
      }
    } else if (workerData.kind === "doc") {
      const WordExtractor = lib && lib.default ? lib.default : lib;
      const document = await new WordExtractor().extract(bytes);
      text = document.getBody() || "";
    } else {
      const result = await lib.extractRawText({ buffer: bytes });
      text = (result && result.value) || "";
    }
    parentPort.postMessage({ type: "text", text });
  } catch (error) {
    parentPort.postMessage({ type: "error", message: String((error && error.message) || error) });
  }
})();
`;

type WorkerReply =
  | { type: "text"; text: string }
  | { type: "images"; images: string[] }
  | { type: "error" | "unavailable"; message: string };
type WorkerAnswer = Extract<WorkerReply, { type: "text" | "images" }>;

export type IsolatedParseOptions = {
  maxOldGenerationSizeMb?: number;
  timeoutMs?: number;
  /** Test seam: replaces the thread's source. Production never sets it. */
  workerSource?: string;
};

/** The thread could not load its library. The file is refused — never parsed in-process without the limits. */
export class CvParseIsolationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CvParseIsolationUnavailableError";
  }
}

/** Run one read in a bounded thread. Resolves its answer; rejects CvParseLimitError, CvParseIsolationUnavailableError or the library's own error. */
function runInBoundedThread(
  bytes: Buffer,
  task: { kind: IsolatedWorkerKind; maxPages?: number },
  options: IsolatedParseOptions,
): Promise<WorkerAnswer> {
  const timeoutMs = options.timeoutMs ?? CV_PARSE_TIMEOUT_MS;
  const maxOld = options.maxOldGenerationSizeMb ?? CV_PARSE_MAX_OLD_GENERATION_MB;
  return new Promise<WorkerAnswer>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(options.workerSource ?? WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: maxOld, maxYoungGenerationSizeMb: CV_PARSE_MAX_YOUNG_GENERATION_MB },
      // A copy: the caller keeps its own buffer untouched (the in-process path never detached it either).
      workerData: { bytes: new Uint8Array(bytes), kind: task.kind, maxPages: task.maxPages ?? 0 },
    });
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      outcome();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new CvParseLimitError("timeout", `Reading this CV file took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`)));
    }, timeoutMs);
    worker.on("message", (reply: WorkerReply) => {
      if (reply.type === "text" || reply.type === "images") finish(() => resolve(reply));
      else if (reply.type === "unavailable") finish(() => reject(new CvParseIsolationUnavailableError(reply.message)));
      else finish(() => reject(new Error(reply.message)));
    });
    worker.on("error", (error: Error & { code?: string }) => {
      const memory = error?.code === "ERR_WORKER_OUT_OF_MEMORY";
      finish(() =>
        reject(
          new CvParseLimitError(
            memory ? "memory" : "crashed",
            memory
              ? `Reading this CV file needed more than ${maxOld} MB of memory and was stopped.`
              : `Reading this CV file failed in its isolated reader: ${error?.message ?? String(error)}`,
          ),
        ),
      );
    });
    worker.on("exit", (code) => {
      finish(() => reject(new CvParseLimitError("crashed", `The isolated CV reader stopped (exit ${code}) without an answer.`)));
    });
  });
}

/** Parse one file in a bounded thread. Resolves the text; rejects CvParseLimitError, CvParseIsolationUnavailableError or the library's own error. */
export async function parseCvTextInWorker(bytes: Buffer, kind: IsolatedCvParseKind, options: IsolatedParseOptions = {}): Promise<string> {
  const answer = await runInBoundedThread(bytes, { kind }, options);
  if (answer.type !== "text") throw new Error("The isolated CV reader answered with images where text was asked for.");
  return answer.text;
}

/**
 * The first embedded image of each page of a PDF, at most `maxPages` of them, read in a bounded
 * thread (cv-ocr.ts). Rejects exactly as parseCvTextInWorker does.
 */
export async function extractPdfPageImagesInWorker(bytes: Buffer, maxPages: number, options: IsolatedParseOptions = {}): Promise<Buffer[]> {
  const answer = await runInBoundedThread(bytes, { kind: "pdf-images", maxPages }, options);
  if (answer.type !== "images") throw new Error("The isolated CV reader answered with text where images were asked for.");
  return answer.images.map((base64) => Buffer.from(base64, "base64"));
}

let loggedUnavailable = false;

/**
 * The text of one CV file, read in a bounded thread. A thread that cannot load its library is
 * REFUSED (CvParseIsolationUnavailableError, logged once per process) — never read in-process.
 */
export async function extractCvTextIsolated(bytes: Buffer, kind: IsolatedCvParseKind, options: IsolatedParseOptions = {}): Promise<string> {
  try {
    return await parseCvTextInWorker(bytes, kind, options);
  } catch (error) {
    if (error instanceof CvParseIsolationUnavailableError && !loggedUnavailable) {
      loggedUnavailable = true;
      logError("CV parsing could not start its isolated reader — the file is refused, not parsed in-process without limits", {
        error,
        labels: { event: "cv_parse_isolation_unavailable", kind },
      });
    }
    throw error;
  }
}
