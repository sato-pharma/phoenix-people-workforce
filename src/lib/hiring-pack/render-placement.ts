// Placing typed values onto official artwork — the one mechanism every government form here uses.
//
// WHY THIS FILE EXISTS. Form 1 established the approach: embed the Authority's own page as vector
// artwork, then position each value over it at coordinates measured out of the source PDF. Four
// more documents now do exactly the same thing — Form 6's two sides, the Ministry of Labour
// resignation request, and the three-page mutual-termination agreement. The placing code is
// identical for all of them and the coordinates are not, so the code lives here once and each
// document contributes only its own measurements.
//
// THE COORDINATE SYSTEM is always the source PDF's own: points, origin at the top-left of the page.
// A value measured at x=311 in the PDF is written as x=311 here and lands at x=311 on the paper,
// with no scaling arithmetic anywhere in between. That is the whole reason the numbers in the
// layout files can be trusted — they are transcriptions, not estimates.

import { escapeHtml } from "@/lib/hiring-pack/render-shared";

export type Placement =
  /** Free text written along a printed dotted rule. */
  | {
      kind: "text";
      key: string;
      /** The field-layer row this came from, ADDED rows only. Undefined for a compiled default. */
      fieldId?: string;
      x: number;
      y: number;
      w: number;
      h: number;
      align: "right" | "center" | "left";
      size?: number;
    }
  /** One character per cell, across a printed box grid, left to right. */
  | {
      kind: "digits";
      key: string;
      fieldId?: string;
      x: number;
      y: number;
      pitch: number;
      cells: number;
      h: number;
      size?: number;
    }
  /** A checkmark inside a single box. */
  | { kind: "tick"; key: string; fieldId?: string; x: number; y: number; w: number; h: number };

/** A page of official artwork and the values that go on it. */
export type FormPage = {
  /** Public path of the page's SVG artwork. */
  svg: string;
  placements: readonly Placement[];
};

/**
 * One value, positioned over the artwork.
 *
 * A key with no value prints nothing at all — deliberately. A half-filled pack still has to print,
 * because the alternative is a screen that refuses to produce the paper somebody needs today; what
 * a missing value must never do is print a guess or a placeholder that reads as data.
 *
 * EVERY VALUE CARRIES ITS OWN KEY as `data-hp-key`, so the preview screen can find it and let an
 * operator correct it on the page itself. A data attribute is inert in print — it has no visual
 * effect anywhere, on paper or on screen — so this costs the printed document nothing. The
 * attribute is the ONLY link between a mark on the paper and the column behind it;
 * `paper-fields.ts` holds the other half and decides which keys may be written at all.
 *
 * `fieldId`, when present, is the field-layer row's own id, carried as `data-hp-field`. Two ADDED
 * fields on one page can share a `data-hp-key` — nothing stops an operator adding the same value
 * twice at different spots — so the key alone cannot address one box in an editor. A compiled
 * default has no row and so no `fieldId`; `data-hp-key` keeps addressing those exactly as before.
 */
export function renderPlacement(placement: Placement, values: Record<string, string>): string {
  const raw = values[placement.key] ?? "";
  if (!raw) return "";
  const key = ` data-hp-key="${escapeHtml(placement.key)}"`;
  const field = placement.fieldId ? ` data-hp-field="${escapeHtml(placement.fieldId)}"` : "";

  if (placement.kind === "tick") {
    return `<span class="f tick"${key}${field} style="left:${placement.x}pt;top:${placement.y}pt;width:${placement.w}pt;height:${placement.h}pt;line-height:${placement.h}pt">${escapeHtml(raw)}</span>`;
  }

  if (placement.kind === "digits") {
    // Digits are written left to right even inside an otherwise right-to-left form, and the grid is
    // clipped to its own cell count so an over-long value can never spill past the printed boxes.
    const characters = [...raw].slice(0, placement.cells);
    const cells = characters
      .map(
        (character, index) =>
          `<span class="cell" style="left:${(index * placement.pitch).toFixed(2)}pt;width:${placement.pitch.toFixed(2)}pt;line-height:${placement.h}pt">${escapeHtml(character)}</span>`,
      )
      .join("");
    const width = placement.pitch * placement.cells;
    const size = placement.size ?? 10;
    return `<span class="f grid"${key}${field} style="left:${placement.x}pt;top:${placement.y}pt;width:${width.toFixed(2)}pt;height:${placement.h}pt;font-size:${size}pt">${cells}</span>`;
  }

  const size = placement.size ?? 9;
  // The text sits in an inner element so `FIT_TO_BOX_SCRIPT` can compress it horizontally when it
  // is wider than the rule it was measured for. Without the wrapper there is nothing to scale: the
  // outer box is what defines the limit, so scaling it would move the limit too.
  return `<span class="f txt"${key}${field} style="left:${placement.x}pt;top:${placement.y}pt;width:${placement.w}pt;height:${placement.h}pt;line-height:${placement.h}pt;text-align:${placement.align};font-size:${size}pt"><span class="ff">${escapeHtml(raw)}</span></span>`;
}

/** One printed side: the artwork, the values on it, and anything the document adds of its own. */
export function renderSheet(
  svg: string,
  placements: readonly Placement[],
  values: Record<string, string>,
  extras = "",
): string {
  const fields = placements.map((placement) => renderPlacement(placement, values)).join("");
  return `<section class="sheet">
    <img class="artwork" src="${svg}" alt="" aria-hidden="true">
    ${fields}
    ${extras}
  </section>`;
}

/**
 * The stylesheet every placed-value document shares, for a page of the given size.
 *
 * The page size is a parameter because the two authorities print on different paper: the social
 * insurance forms are US Legal (612.12 x 1008.12pt) and the Ministry of Labour forms are US Letter
 * (612 x 792pt). Printing either on A4 shrinks it or clips it, and neither is a form an office
 * accepts, so `@page` states the real size and the print banner repeats it for the human.
 */
export function placedFormCss(widthPt: number, heightPt: number, arabicFontStack: string): string {
  return `
  @page { size: ${widthPt}pt ${heightPt}pt; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  body { font-family: ${arabicFontStack}; }

  .sheet {
    position: relative;
    width: ${widthPt}pt;
    height: ${heightPt}pt;
    margin: 0 auto 18px;
    background: #fff;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }
  .sheet:last-child { page-break-after: auto; break-after: auto; margin-bottom: 0; }

  .artwork {
    position: absolute; inset: 0;
    width: ${widthPt}pt; height: ${heightPt}pt;
    /* The official artwork is a background, never a target: it must not intercept a click, and it
       must not be dragged out of the page as an image. */
    pointer-events: none; user-select: none;
  }

  /* Every filled value. Absolute, in the PDF's own points, so a coordinate measured off the source
     lands unchanged on the paper. */
  .f {
    position: absolute;
    display: block;
    color: #000;
    white-space: nowrap;     /* a wrapped value in a one-line slot is unreadable, never allowed */
    overflow: visible;
    font-family: ${arabicFontStack};
  }
  .txt { font-weight: 600; }
  /* The compressible inner run. inline-block so it reports its own natural width, which is what
     tells the fit script how far past its rule a value has run. */
  .ff { display: inline-block; white-space: nowrap; }
  .tick { text-align: center; font-size: 13pt; font-weight: 700; }
  /* One digit per printed cell, so no letter-spacing — it would push a centred digit off its box. */
  .wage { direction: ltr; text-align: center; font-size: 10pt; font-weight: 700; }
  .grid { direction: ltr; font-weight: 700; }
  .grid .cell { position: absolute; top: 0; display: block; text-align: center; }

  @media print {
    html, body { background: #fff; }
    .sheet { margin: 0; box-shadow: none; }
    /* Without this the browser drops the form's own rules and boxes to save toner, and what comes
       out is a page of floating values with no form around them. */
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }`;
}

/**
 * Keeps an over-long value inside the rule it was measured for.
 *
 * WHY THIS IS NECESSARY, AND WHAT IT REPLACES. Every coordinate in the layout files is a
 * transcription of a printed rule, and a rule is as long as the authority drew it — not as long as
 * the value it has to hold. Sato Pharma's head office address is 74 characters and the
 * mutual-termination agreement gives مقر الشركة about 117pt for it. With `white-space: nowrap` and
 * `overflow: visible`, which are both deliberate, the surplus does not wrap and does not disappear:
 * it prints straight across the page. On page 3 of that agreement it ran out of the employer's
 * column and over the EMPLOYEE's printed labels — two parties' details overprinted on the one page
 * a labour inspector reads.
 *
 * The three obvious alternatives are all worse and two of them are ruled out outright. Wrapping
 * turns a one-line slot into an unreadable stack. Truncating with an ellipsis drops characters from
 * a legal document — and never truncating with an ellipsis is a standing owner rule besides.
 * Clipping is truncation that does not even admit it happened. Compressing the glyphs horizontally
 * keeps every character, keeps one line, and keeps the value inside its own rule.
 *
 * IT RUNS IN THE BROWSER BECAUSE ONLY THE BROWSER CAN MEASURE. Text width depends on the font that
 * actually resolved, and Arabic shaping means it is not a sum of character widths — the server
 * cannot know it. The script is inert if it never runs: the page renders exactly as it did before,
 * which is the pre-existing behaviour rather than a new failure mode.
 *
 * It deliberately does NOT touch digit grids or ticks. Those are one character per printed box, and
 * a compressed digit would no longer sit in its box.
 */
export const FIT_TO_BOX_SCRIPT = `<script>
(function () {
  var fit = function () {
    var boxes = document.querySelectorAll(".f.txt");
    for (var i = 0; i < boxes.length; i += 1) {
      var box = boxes[i];
      var inner = box.firstElementChild;
      if (!inner) continue;
      inner.style.transform = "";
      var available = box.clientWidth;
      var needed = inner.getBoundingClientRect().width;
      if (!available || !needed || needed <= available) continue;
      var align = box.style.textAlign;
      inner.style.transformOrigin = align === "center" ? "center" : align === "left" ? "left" : "right";
      inner.style.transform = "scaleX(" + (available / needed).toFixed(4) + ")";
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fit);
  } else {
    fit();
  }
  // Re-measured once the web fonts land: the first pass runs against the fallback face, and an
  // Arabic fallback is not the same width as the face that finally renders.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  window.addEventListener("beforeprint", fit);
})();
</script>`;
