// The company seal, as the bytes a placed stamp prints.
//
// SEPARATE FROM `document-marks.ts` BECAUSE OF WHO IMPORTS WHAT. That module holds the mark
// vocabulary, the labels and the default sizes, and `paper-editor.tsx` — a "use client" component —
// needs all three. A `node:fs` import there would pull a filesystem read into the browser bundle.
// So the reader lives here, beside `hr-signature.ts`, and both are reached only from the server.
//
// WHY A DATA URI RATHER THAN `src="/brand/sato-hr-seal.svg"`, which `paper-artwork.ts` already
// allow-lists: the filing path hands the finished HTML to Chromium through `setContent`, which gives
// the page no origin, so a root-relative path resolves to nothing and the image silently fails to
// load. The signature has no choice about this — it lives in a private bucket — and one mechanism
// for both marks means neither can end up on a filed paper as a hole where a stamp should be.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cached for the life of the process, INCLUDING the failure.
 *
 * A missing file here is a deployment fault, not a transient one, so retrying it buys nothing and
 * costs a syscall per placement per copy of every paper printed. The path is spelled out rather than
 * built, for the reason `paper-artwork.ts` gives at length: Turbopack's build tracer only follows a
 * `join(process.cwd(), …)` it can read statically, and a path assembled from a parameter defeats the
 * tracer and accepts whatever it is handed besides.
 */
let sealCache: string | null | undefined;

export function stampArtworkUri(): string | null {
  if (sealCache !== undefined) return sealCache;
  try {
    const bytes = readFileSync(join(process.cwd(), "public", "brand", "sato-hr-seal.svg"));
    sealCache = `data:image/svg+xml;base64,${bytes.toString("base64")}`;
  } catch {
    sealCache = null;
  }
  return sealCache;
}
