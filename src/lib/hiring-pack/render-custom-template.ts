// Printing a paper somebody uploaded — the same mechanism the government forms use, with nothing
// compiled in.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS DIFFERENT ABOUT A COMPANY TEMPLATE, AND WHAT IS NOT.
//
// Not different: it is a page surface. Fixed artwork, values placed over it at coordinates in the
// page's own points, exactly as Form 1 and Form 6 work. `renderSheet`, `placedFormCss` and
// `FIT_TO_BOX_SCRIPT` are the same functions those documents call, so a value on a company template
// prints in the same face, at the same size, clipped to its box the same way. That is the point of
// having one field layer rather than two.
//
// Different: THERE ARE NO COMPILED PLACEMENTS. Form 1's coordinates were transcribed out of the
// Authority's own PDF by somebody holding a ruler; nobody has done that for a paper uploaded five
// minutes ago, and nobody can — the code has never seen it. So every page starts with an empty
// placement list and everything on it comes from the field layer: boxes an operator dropped on the
// page, each bound to a value or carrying fixed text. A template with no fields yet prints its
// artwork and nothing else, which is correct — it is a blank form, which is what it was uploaded as.
//
// AND THE ARTWORK IS A URL, NOT AN INLINE IMAGE. `/api/hiring-pack/template-artwork/<pageId>` streams
// the page from the private bucket behind the same permission this document prints under. Inlining
// a scan at print resolution would put several megabytes inside the rendered HTML; this repository
// has already learnt what a payload that size does to a dev server.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { CustomTemplate } from "@/lib/hiring-pack/custom-template-store";
import { layeredPages, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { PAPER_FIELD_BINDINGS, paperFieldCurrentValue } from "@/lib/hiring-pack/paper-fields";
import {
  FIT_TO_BOX_SCRIPT,
  placedFormCss,
  renderSheet,
} from "@/lib/hiring-pack/render-placement";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  formatDayMonthYear,
  formatMoney,
  PRINT_BANNER_CSS,
  printBanner,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

/** The public URL an uploaded page's artwork is served from. */
export function templateArtworkUrl(pageId: string): string {
  return `/api/hiring-pack/template-artwork/${encodeURIComponent(pageId)}`;
}

/**
 * EVERY value this system knows about a person, keyed the way the field editor names them.
 *
 * The ten compiled documents each have a values builder that answers exactly the keys that document
 * places — `buildForm1Values` returns Form 1's twenty-odd and nothing else, because the compiled
 * placements are the only things that will ever look them up. A company template has no such list:
 * an uploaded paper could ask for a national ID, a qualification, a last working day or a salary,
 * and which of those it asks for is decided by whoever drops the boxes, after this code ran.
 *
 * So the map is the WHOLE binding table. `PAPER_FIELD_BINDINGS` is already the catalogue of every
 * value these papers can print and where each one is stored, and `paperFieldCurrentValue` is
 * already the one function that reads a binding — the same one the paper editor calls when somebody
 * clicks a value to correct it. Reusing both means a company template's field cannot show one thing
 * and the editor another.
 *
 * FORMATTING FOLLOWS THE HOUSE, and is not invented here:
 *
 *   date   → dd / mm / yyyy, which is what the six typeset documents print and how a date is
 *            written by hand in Egypt. An ISO date on an Arabic form reads as a machine's output.
 *   money  → the contract's own formatter, digits grouped, piastres only when there are any.
 *   others → exactly as stored. A national ID is digits; a name is a name.
 *
 * A date the paper wants split across printed boxes needs no special case: the binding table
 * already carries `startDay`, `startMonth` and `startYear` as separate keys, and a literal field
 * can compose any other arrangement with placeholders — "{{startDay}} / {{startMonth}}".
 */
export function buildCustomTemplateValues(data: HiringPackData): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, binding] of Object.entries(PAPER_FIELD_BINDINGS)) {
    const stored = paperFieldCurrentValue(data, binding);
    if (!stored) {
      // A key with no value is still a key. It is written as the empty string rather than left out
      // so that `documentFieldInventory` lists it as a field the operator MAY place — the whole
      // reason somebody uploads a form is to fill in the things that are currently blank.
      values[key] = "";
      continue;
    }

    values[key] =
      binding.kind === "date"
        ? formatDayMonthYear(stored)
        : binding.kind === "money"
          ? formatMoney(Number(stored))
          : stored;
  }

  return values;
}

/**
 * One uploaded template, filled for one person, ready to print.
 *
 * @param fields The operator's field layer for THIS VERSION of the template. Empty prints the blank
 *   form — see the header. A layout is measured against one piece of artwork, so replacing a
 *   template's artwork creates a new version with its own layer rather than carrying coordinates
 *   onto a page nobody re-measured.
 */
export function renderCustomTemplateHtml(
  template: CustomTemplate,
  data: HiringPackData,
  copies: number,
  fields: readonly DocumentFieldRow[] = [],
): string {
  const values = buildCustomTemplateValues(data);

  // Sorted by the stored page index, never by insertion order. A two-sided form whose back printed
  // first is a form somebody signs on the wrong side, and the page NUMBER a field was dropped on is
  // this list's position — so the order here and the order in the editor have to be one thing.
  const ordered = [...template.pages].sort((a, b) => a.pageIndex - b.pageIndex);

  const pages = layeredPages(
    ordered.map((page) => ({ svg: templateArtworkUrl(page.id), placements: [] })),
    values,
    fields,
  );

  const sheets: string[] = [];
  for (let copy = 0; copy < Math.max(1, copies); copy += 1) {
    for (const page of pages) {
      sheets.push(renderSheet(page.svg, page.placements, page.values, ""));
    }
  }

  const employeeName = data.employee.nameAr ?? data.employee.fullName;
  const title = `${template.nameAr ?? template.name} — ${employeeName}`;

  // The paper size, in millimetres, for the human standing at the printer. The points are the
  // truth — they came out of the uploaded file itself — and mm is what a paper tray is labelled in.
  const widthMm = Math.round((template.pageWidthPt / 72) * 25.4);
  const heightMm = Math.round((template.pageHeightPt / 72) * 25.4);

  const banner: string[] = [
    `Paper size: ${widthMm} × ${heightMm} mm, read from the uploaded file itself. ` +
      `${copies} ${copies === 1 ? "copy is" : "copies are"} already laid out below — leave the ` +
      "dialog's copy count at 1.",
    "Scale must stay at 100% / “Actual size”. Fit-to-page shifts every value off its box.",
  ];
  if (ordered.length > 1) {
    banner.unshift(
      `${ordered.length} pages. If this template is a two-sided form, tick “Print on both sides”.`,
    );
  }

  // `dir="rtl"` and the Arabic stack, as every other document here does: a company template is a
  // paper for an Egyptian office, and a value that is Arabic must shape and order correctly. An
  // English value inside it is unaffected — the direction applies per line.
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${placedFormCss(template.pageWidthPt, template.pageHeightPt, ARABIC_FONT_STACK)}
  ${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner(banner)}
${sheets.join("\n")}
${FIT_TO_BOX_SCRIPT}
</body>
</html>`;
}
