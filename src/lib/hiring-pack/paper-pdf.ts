// The signed paper as a PDF, for filing into the employee's hiring documents.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE BROWSER STILL PRINTS THE PAPER. Nothing here replaces that, and the note above `openPrint`
// still holds: a person at a print dialog is the only thing that can set duplex and paper size, and
// the browser is the only thing in this stack that lays Arabic out correctly. What changed is that
// the FILED copy has no person at a dialog — it has to exist the moment the owner confirms the
// signature — which is precisely the constraint the offer letter has always had. Same constraint,
// same answer: Chromium renders the document, so the file is the paper.
//
// WHY NOT RASTERISE IN THE BROWSER, which was the original plan. Four of the seven papers are
// values placed over scanned artwork and would rasterise cleanly. The other three — the employment
// contract and the two clearances — FLOW: `.copy { min-height: 297mm }` and a `<tfoot>` that Chrome
// repeats across breaks. Their page count is decided by the print engine and is not knowable from
// the DOM, so "rasterise each page element" has nothing to enumerate. Slicing one tall image at
// page height would cut through lines of Arabic on a legal instrument. Chromium paginates it
// properly because Chromium is what paginates it on paper.
//
// And the result is better in three ways that matter later: the text is selectable, so a filed
// contract can be searched; the file is a fraction of the size of a raster; and the artwork is the
// original vector rather than a screenshot of it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GEOMETRY COMES FROM THE DOCUMENT, NEVER FROM HERE. Every renderer declares its own `@page` rule
// because the size is a property of the form: Form 1 is US Legal (612.12 x 1008.12pt — the official
// artwork's exact measurement, and A4 would clip it), the contract is A4 with 10.7/10.2/12.7mm
// margins, the artwork forms take `margin: 0` because their fields are placed at measured points.
//
// So NO `format` and NO `margin` are passed below, only `preferCSSPageSize`. Measured on Chrome
// 2026-09-04 rather than assumed, because the offer path passes both and its comment could be read
// either way:
//
//   @page margin:0    + no margin option -> 297mm of content fits one page   (CSS won)
//   @page margin:0    + margin option 0  -> 297mm of content fits one page   (CSS won)
//   @page margin:10mm + no margin option -> 297mm of content spills to two   (CSS won)
//   @page margin:10mm + margin option 0  -> 297mm of content spills to two   (CSS won, option lost)
//
// The last line is the one that settles it: an explicit zero margin did NOT override the sheet's
// own 10mm. With `preferCSSPageSize` the document governs, and passing a margin here would be a
// value that silently does nothing — which is worse than not passing one, because the next person
// to read it would believe it.

import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";

/** Thrown when the paper rendered, but not faithfully enough to file. */
export class PaperArtworkMissingError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `The artwork for this paper could not be read (${missing.join(", ")}), so filing it would file `
        + "a blank form. Nothing was filed.",
    );
    this.name = "PaperArtworkMissingError";
    this.missing = missing;
  }
}

export { ChromiumUnavailableError };

/**
 * Render one hiring paper's print HTML to PDF bytes.
 *
 * REFUSES RATHER THAN FILES A BLANK. If any local image could not be read off disk the paper would
 * render as correctly-placed values on white, which is indistinguishable from a scanning fault to
 * anyone who opens it later. That is the one failure worth throwing over: the signature has already
 * been recorded by this point and the print tab still opens, so the cost of refusing is a message
 * saying the copy was not filed, against the cost of a blank Form 1 sitting in the record as though
 * it were the signed one.
 */
export async function renderHiringPaperPdf(printHtml: string): Promise<Uint8Array> {
  const { html, missing } = inlineLocalAssets(printHtml);
  if (missing.length > 0) throw new PaperArtworkMissingError(missing);

  return withChromiumPage(async (page) => {
    // `domcontentloaded` is sufficient and `networkidle0` would be wrong: after the inlining above
    // the document makes NO network requests at all, so waiting for the network to fall idle would
    // wait for something that already happened, on every paper.
    await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
    // Chromium applies `@media screen` by default even when producing a PDF. Emulating print is
    // what hides the `.no-print` banner — the black instruction bar with the Print button, which
    // would otherwise be the first thing on the filed page.
    await page.emulateMediaType("print");
    // Two things are still in flight at `domcontentloaded` and both move type on the page: the
    // Arabic webfonts, and `FIT_TO_BOX_SCRIPT`, which shrinks any value too wide for its measured
    // box. Waiting for fonts and then one frame lets both settle. `document.fonts.ready` resolves
    // immediately when there is nothing to load, so this costs the typeset papers nothing.
    await page.evaluate(
      "(async () => { try { await document.fonts.ready; } catch {} "
        + "await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); })()",
    );

    return page.pdf({
      // The artwork IS a background in CSS terms on some sheets, and every form's rules, boxes and
      // tints are backgrounds. Without this the government forms print as bare text.
      printBackground: true,
      // See the measurement at the top of this file. This is the only geometry instruction given.
      preferCSSPageSize: true,
      timeout: 30_000,
    });
  });
}
