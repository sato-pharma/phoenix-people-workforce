// The scanned artwork a printed paper sits on, read off disk instead of fetched.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL. Every artwork-backed paper places its values over an `<img src="/forms/…">`
// — a public asset the browser fetches while displaying the print page. That works because the
// browser is on the site. The filing path is not: it hands the same HTML to Chromium through
// `setContent`, which gives the page NO ORIGIN, so a root-relative `/forms/…` resolves to nothing
// and the image never loads.
//
// The result of getting this wrong is the worst kind of wrong available here. Form 1 would render
// as the employee's values, correctly placed, floating on a blank white page — and it would be
// filed, under a slot named "Social insurance form", as the document that was signed. It would look
// like a rendering glitch to anybody who opened it and like nothing at all to anybody who did not.
//
// So an asset that cannot be read is REPORTED, never skipped. `inlineLocalAssets` returns what it
// could not resolve and the caller refuses to file. A missing file is rare and fixable; a filed
// blank form is neither, because nobody goes looking for it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY EVERY PATH IS SPELLED OUT BELOW instead of built from the URL. `join(process.cwd(), …)` is
// only followed by Turbopack's build tracer when it can statically read the call — see the note in
// `src/lib/offers/brand.ts`, where a variadic helper made ONE route trace 6,034 files and drew
// Turbopack's own "over bundling" warning. A `join(process.cwd(), "public", segment)` built from a
// parameter would defeat the tracer the same way, and would additionally accept any path the HTML
// happened to contain. The switch is verbose on purpose: it is both the tracer's evidence and the
// allow-list.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The result of resolving a document's images: the rewritten HTML, and anything that failed. */
export type InlinedArtwork = {
  html: string;
  missing: string[];
};

const cache = new Map<string, string | null>();

/**
 * One asset as a `data:` URI, or null when it cannot be read.
 *
 * The switch is the allow-list. A path that is not one of these ten is not a Phoenix asset, and
 * answering null for it is the honest response — it will be reported as missing rather than read.
 */
function readAsset(publicPath: string): string | null {
  switch (publicPath) {
    case "/forms/social-insurance-form1-page1.svg":
      return svg(read(join(process.cwd(), "public", "forms", "social-insurance-form1-page1.svg")));
    case "/forms/social-insurance-form1-page2.svg":
      return svg(read(join(process.cwd(), "public", "forms", "social-insurance-form1-page2.svg")));
    case "/forms/social-insurance-form6-page1.svg":
      return svg(read(join(process.cwd(), "public", "forms", "social-insurance-form6-page1.svg")));
    case "/forms/social-insurance-form6-page2.svg":
      return svg(read(join(process.cwd(), "public", "forms", "social-insurance-form6-page2.svg")));
    case "/forms/labour-resignation-request.svg":
      return svg(read(join(process.cwd(), "public", "forms", "labour-resignation-request.svg")));
    case "/forms/labour-mutual-termination-page1.svg":
      return svg(read(join(process.cwd(), "public", "forms", "labour-mutual-termination-page1.svg")));
    case "/forms/labour-mutual-termination-page2.svg":
      return svg(read(join(process.cwd(), "public", "forms", "labour-mutual-termination-page2.svg")));
    case "/forms/labour-mutual-termination-page3.svg":
      return svg(read(join(process.cwd(), "public", "forms", "labour-mutual-termination-page3.svg")));
    // The two logo files are NOT interchangeable. `sato-pharma-logo.png` draws the word SATO in
    // WHITE — correct on the navy sidebar it was made for, invisible on paper. Each renderer
    // already chooses; this only has to read what it chose.
    // THE VECTOR MARK, which is what the letterhead now asks for. The two PNGs stay allow-listed
    // below: an archived contract reprints the artwork it was signed with, and contract-v2's banded
    // layout still references the raster.
    case "/brand/sato-pharma-logo-on-light.svg":
      return svg(read(join(process.cwd(), "public", "brand", "sato-pharma-logo-on-light.svg")));
    case "/brand/sato-pharma-logo.svg":
      return svg(read(join(process.cwd(), "public", "brand", "sato-pharma-logo.svg")));
    case "/brand/sato-pharma-logo-on-light.png":
      return png(read(join(process.cwd(), "public", "brand", "sato-pharma-logo-on-light.png")));
    case "/brand/sato-pharma-logo.png":
      return png(read(join(process.cwd(), "public", "brand", "sato-pharma-logo.png")));
    default:
      return null;
  }
}

function read(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function svg(bytes: Buffer | null): string | null {
  return bytes ? `data:image/svg+xml;base64,${bytes.toString("base64")}` : null;
}

function png(bytes: Buffer | null): string | null {
  return bytes ? `data:image/png;base64,${bytes.toString("base64")}` : null;
}

function assetDataUri(publicPath: string): string | null {
  const hit = cache.get(publicPath);
  if (hit !== undefined) return hit;
  const value = readAsset(publicPath);
  cache.set(publicPath, value);
  return value;
}

/**
 * Rewrite every local `src="/forms/…"` and `src="/brand/…"` in a rendered paper to a `data:` URI.
 *
 * ONLY `src` ATTRIBUTES, and only those two directories. Anything else in the document is left
 * exactly as it was: this is not a general asset resolver, it is the narrow fix for the one thing
 * `setContent` cannot do. A document that references nothing local passes through unchanged and
 * reports nothing missing, which is the correct answer for the typeset papers — the contract and
 * the two clearances draw no artwork at all.
 *
 * DUPLICATES ARE RESOLVED ONCE. A three-copy Form 1 names the same two files six times; the cache
 * means six substitutions and two reads. The HTML does grow by the base64 of each occurrence, which
 * is why the filing path asks for a single copy — see `paper-pdf.ts`.
 */
export function inlineLocalAssets(html: string): InlinedArtwork {
  const missing = new Set<string>();
  const inlined = html.replace(/src="(\/(?:forms|brand)\/[^"]+)"/g, (whole, publicPath: string) => {
    const dataUri = assetDataUri(publicPath);
    if (!dataUri) {
      missing.add(publicPath);
      return whole;
    }
    return `src="${dataUri}"`;
  });
  return { html: inlined, missing: [...missing] };
}
