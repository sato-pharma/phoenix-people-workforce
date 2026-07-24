// Recruitment / ATS — DOMMatrix polyfill for pdf-parse/pdfjs-dist in Node.
//
// pdfjs-dist's legacy build (used by pdf-parse for local getText() extraction) references the
// browser-only `DOMMatrix` global unconditionally at module top level (`const SCALE_MATRIX = new
// DOMMatrix();`), even though text extraction never renders/paints anything. pdfjs-dist can
// auto-detect the native `@napi-rs/canvas` package (pdf-parse's own dependency) to supply a real
// DOMMatrix, but Next's production file-tracing (`.next/standalone`, see the Dockerfile's
// puppeteer-core comment for the same class of gap) drops that native addon, so `@napi-rs/canvas`
// is absent at runtime and DOMMatrix stays undefined — crashing every route that imports
// cv-extraction.ts with `ReferenceError: DOMMatrix is not defined` at import time, not parse time.
//
// A small spec-compliant pure-JS shim is enough: getText() only needs DOMMatrix's 2D-affine math
// (construct/translate/scale/multiply), never actual canvas rendering (confirmed by reproducing
// the crash locally with @napi-rs/canvas removed, then resolving it with this polyfill, against
// both plain-text and vector-graphics/clipping-path PDFs).
//
// Must be imported before "pdf-parse" so this runs first (see cv-extraction.ts import order).
import CSSMatrix from "dommatrix";

type GlobalWithDOMMatrix = typeof globalThis & { DOMMatrix?: unknown };

const globalWithDOMMatrix = globalThis as GlobalWithDOMMatrix;
if (typeof globalWithDOMMatrix.DOMMatrix === "undefined") {
  globalWithDOMMatrix.DOMMatrix = CSSMatrix;
}
