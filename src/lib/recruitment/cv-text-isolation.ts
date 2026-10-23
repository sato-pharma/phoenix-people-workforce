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
// IT CAN NEVER BE WORSE THAN BEFORE. If the thread cannot even LOAD a library (a production image whose
// file tracing left a package out), the parse falls back to the in-process path exactly as it ran
// before this file existed, and says so once in the log. Only a parse that STARTED and then broke a
// limit is refused.

import { Worker } from "node:worker_threads";

import { logError } from "@/lib/observability/log";

export const CV_PARSE_TIMEOUT_MS = 30_000;
export const CV_PARSE_MAX_OLD_GENERATION_MB = 384;
export const CV_PARSE_MAX_YOUNG_GENERATION_MB = 64;

export type IsolatedCvParseKind = "pdf" | "docx" | "doc";

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
// pdf-dommatrix-polyfill.ts uses).
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  let lib;
  if (typeof globalThis.DOMMatrix === "undefined") {
    // Optional: where the shim is not on disk, pdfjs can still take DOMMatrix from @napi-rs/canvas,
    // and if neither is there pdf-parse fails to load just below and the parse falls back in-process.
    try {
      const matrix = require("dommatrix");
      globalThis.DOMMatrix = matrix && matrix.default ? matrix.default : matrix;
    } catch {}
  }
  try {
    lib = workerData.kind === "pdf" ? require("pdf-parse") : workerData.kind === "doc" ? require("word-extractor") : require("mammoth");
  } catch (error) {
    parentPort.postMessage({ type: "unavailable", message: String((error && error.message) || error) });
    return;
  }
  try {
    const source = workerData.bytes;
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    let text;
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

type WorkerReply = { type: "text"; text: string } | { type: "error" | "unavailable"; message: string };

export type IsolatedParseOptions = {
  maxOldGenerationSizeMb?: number;
  timeoutMs?: number;
  /** Test seam: replaces the thread's source. Production never sets it. */
  workerSource?: string;
};

/** The thread could not load its library — the caller should parse in-process, as before. */
export class CvParseIsolationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CvParseIsolationUnavailableError";
  }
}

/** Parse one file in a bounded thread. Resolves the text; rejects CvParseLimitError, CvParseIsolationUnavailableError or the library's own error. */
export function parseCvTextInWorker(bytes: Buffer, kind: IsolatedCvParseKind, options: IsolatedParseOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CV_PARSE_TIMEOUT_MS;
  const maxOld = options.maxOldGenerationSizeMb ?? CV_PARSE_MAX_OLD_GENERATION_MB;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(options.workerSource ?? WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: maxOld, maxYoungGenerationSizeMb: CV_PARSE_MAX_YOUNG_GENERATION_MB },
      // A copy: the caller keeps its own buffer untouched (the in-process path never detached it either).
      workerData: { bytes: new Uint8Array(bytes), kind },
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
      if (reply.type === "text") finish(() => resolve(reply.text));
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

let loggedUnavailable = false;

/**
 * The text of one CV file: in a bounded thread, or — only when the thread cannot load its library —
 * in-process through `inProcess`, which is the pre-isolation code path unchanged.
 */
export async function extractCvTextIsolated(
  bytes: Buffer,
  kind: IsolatedCvParseKind,
  inProcess: () => Promise<string>,
  options: IsolatedParseOptions = {},
): Promise<string> {
  try {
    return await parseCvTextInWorker(bytes, kind, options);
  } catch (error) {
    if (!(error instanceof CvParseIsolationUnavailableError)) throw error;
    if (!loggedUnavailable) {
      loggedUnavailable = true;
      logError("CV parsing could not start its isolated reader — parsing in-process, without limits", {
        error,
        labels: { event: "cv_parse_isolation_unavailable", kind },
      });
    }
    return inProcess();
  }
}
