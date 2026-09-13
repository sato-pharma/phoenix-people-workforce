// Printing one of the pack's government forms — the artwork as issued, plus whatever fields an
// operator has placed on it. See `official-pack-forms.ts` for why there are no compiled placements.
//
// The same three functions every page document calls — `renderSheet`, `placedFormCss` and
// `FIT_TO_BOX_SCRIPT` — and the same value bag an uploaded company template gets, since what these
// forms ask for is decided by whoever places the boxes, not by this code.

import { layeredPages, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { OFFICIAL_PACK_FORMS } from "@/lib/hiring-pack/official-pack-forms";
import { buildCustomTemplateValues } from "@/lib/hiring-pack/render-custom-template";
import { FIT_TO_BOX_SCRIPT, placedFormCss, renderSheet } from "@/lib/hiring-pack/render-placement";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  PRINT_BANNER_CSS,
  printBanner,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData, OfficialPackFormDocument } from "@/lib/hiring-pack/types";

/** The renderer for one form, in the shape the print table expects. */
export function renderOfficialPackFormHtml(document: OfficialPackFormDocument) {
  return (
    data: HiringPackData,
    copies: number,
    _templateVersionId?: string | null,
    fields: readonly DocumentFieldRow[] = [],
  ): string => {
    const form = OFFICIAL_PACK_FORMS[document];
    const values = buildCustomTemplateValues(data);
    const pages = layeredPages(
      form.pages.map((svg) => ({ svg, placements: [] })),
      values,
      fields,
    );

    const total = Math.max(1, copies);
    const sheets: string[] = [];
    for (let copy = 0; copy < total; copy += 1) {
      for (const page of pages) sheets.push(renderSheet(page.svg, page.placements, page.values, ""));
    }

    const widthMm = Math.round((form.widthPt / 72) * 25.4);
    const heightMm = Math.round((form.heightPt / 72) * 25.4);
    const landscape = form.widthPt > form.heightPt;

    const banner: string[] = [
      `${form.titleAr} — the form ${form.issuerEn} issues, printed exactly as issued. Nothing Phoenix ` +
        "wrote is on its face: complete it by hand, or place fields on it in the Template Studio.",
      `Paper size: A4 ${landscape ? "landscape" : "portrait"} (${widthMm} × ${heightMm} mm). ` +
        `${total} ${total === 1 ? "copy is" : "copies are"} laid out below — leave the dialog's copy count at 1.`,
      "Scale must stay at 100% / “Actual size”. Fit-to-page shifts every placed value off its box.",
    ];
    if (form.pages.length > 1) {
      banner.unshift(`${form.pages.length} pages. Tick “Print on both sides” if the office takes it as one sheet.`);
    }
    if (form.provisional) {
      banner.push(
        "This artwork is a photograph of a copy, not the clean original file. It prints legibly; it is replaced as soon as the original arrives.",
      );
    }

    const employeeName = data.employee.nameAr ?? data.employee.fullName;
    return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${form.titleAr} — ${employeeName}`)}</title>
<style>
${placedFormCss(form.widthPt, form.heightPt, ARABIC_FONT_STACK)}
  ${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner(banner)}
${sheets.join("\n")}
${FIT_TO_BOX_SCRIPT}
</body>
</html>`;
  };
}
