// Recruitment / ATS — the stylesheet a printed candidate record wears.
//
// PURE and in its own file for two reasons. A test can hold the string up, and a headless browser can
// print exactly it. And the client component that frames the sheet (src/components/recruitment/
// candidate-record-print.tsx) needs one constant from here — the class that hides its toolbar on the
// paper — and must not pull the whole record builder into the browser to get it.
//
// SQUARE EDGES, HAIRLINES, NO FILLS: the house identity SATO-DIS-2026-01 v1.0. The letterhead and the
// engine-turned band come from the house stylesheet; everything below is scoped under `.rec`, so it
// cannot restyle the toolbar around it on the screen. Type is 9 pt: a record runs to several pages, and
// this is a reference sheet read close.
//
// The page number and the document standard sit in the page's own margin boxes, which a browser that
// does not draw them simply leaves out — the printed time is at the top of the first page as well.

import { HOUSE_DOCUMENT_STANDARD } from "@/lib/export/house-xlsx-palette";
import { HOUSE_IDENTITY_CSS } from "@/lib/hiring-pack/house-identity";

/** Anything with this class is on the screen only and is hidden on the paper. */
export const CANDIDATE_RECORD_SCREEN_ONLY_CLASS = "rec-screen-only";

/** A string inside a CSS `content: "…"`. Only ever fed the printed label and the document standard. */
function cssString(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

export function candidateRecordPrintCss(printedLabel: string): string {
  return `
  ${HOUSE_IDENTITY_CSS}
  @page {
    size: A4 portrait;
    margin: 14mm 15mm 17mm;
    @bottom-left { content: "${cssString(`${HOUSE_DOCUMENT_STANDARD} · Candidate record · ${printedLabel}`)}"; color: #5b6472; font: 6.5pt "Segoe UI", Arial, sans-serif; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); color: #5b6472; font: 6.5pt "Segoe UI", Arial, sans-serif; }
  }
  .rec, .rec * { box-sizing: border-box; border-radius: 0; }
  .rec { color: var(--phx-doc-body); font-family: "Segoe UI", Tahoma, Arial, "Noto Sans Arabic", "Noto Naskh Arabic", sans-serif; font-size: 9pt; line-height: 1.38; }
  @media screen { .rec { max-width: 210mm; margin: 0 auto; padding: 14mm 15mm; background: #fff; border: 1px solid var(--phx-doc-hair); } }
  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    .${CANDIDATE_RECORD_SCREEN_ONLY_CLASS} { display: none !important; }
    .rec { max-width: none; margin: 0; padding: 0; border: 0; }
  }
  .rec .eyebrow { margin: 3.4mm 0 0; color: var(--phx-doc-muted); font-size: 7pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .rec h1 { margin: 1mm 0 0; color: var(--phx-doc-body); font-size: 13pt; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
  .rec .sub { margin: 1mm 0 0; color: var(--phx-doc-muted); font-size: 9.6pt; overflow-wrap: anywhere; }
  .rec .printed { margin: .8mm 0 0; color: var(--phx-doc-muted); font-size: 7pt; }
  .rec .notice { margin: 3mm 0 0; padding: 1.4mm 0; border-top: .5pt solid var(--phx-doc-hair); border-bottom: .5pt solid var(--phx-doc-hair); break-inside: avoid; }
  .rec .notice strong { display: block; color: var(--phx-doc-deep); font-size: 9pt; font-weight: 700; overflow-wrap: anywhere; }
  .rec .notice span { display: block; color: var(--phx-doc-muted); font-size: 7.6pt; }
  .rec section { margin-top: 5mm; }
  .rec h2 { display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; margin: 0 0 .8mm; padding-bottom: .9mm; border-bottom: .5pt solid var(--phx-doc-blue); color: var(--phx-doc-deep); font-size: 9.4pt; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; break-after: avoid; page-break-after: avoid; }
  .rec h2 .aside { color: var(--phx-doc-muted); font-size: 7.6pt; font-weight: 600; letter-spacing: 0; text-align: right; text-transform: none; overflow-wrap: anywhere; }
  .rec h3 { display: flex; justify-content: space-between; gap: 4mm; margin: 2.6mm 0 .3mm; color: var(--phx-doc-muted); font-size: 7.2pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; break-after: avoid; page-break-after: avoid; }
  .rec table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .rec th, .rec td { padding: 1.15mm 0; border-bottom: .5pt solid var(--phx-doc-hair); vertical-align: top; text-align: start; overflow-wrap: anywhere; }
  .rec th { width: 27%; padding-inline-end: 3mm; color: var(--phx-doc-muted); font-size: 7.3pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .rec th.s { font-size: 8.3pt; font-weight: 500; letter-spacing: 0; text-transform: none; }
  .rec tr { break-inside: avoid; page-break-inside: avoid; }
  .rec .ln { display: block; }
  .rec .pl { white-space: pre-line; }
  .rec .n { display: block; color: var(--phx-doc-muted); font-size: 7.6pt; }
  .rec .v + .v { margin-top: 1mm; }
  .rec .hedged .ln { color: var(--phx-doc-muted); font-style: italic; }
  .rec .entry { padding-inline-start: 2mm; border-inline-start: .5pt solid var(--phx-doc-hair); }
  .rec .entry .ln b { color: var(--phx-doc-muted); font-size: 7.6pt; font-weight: 700; }
  .rec ul.items, .rec ol.events, .rec ul.notes { margin: 0; padding: 0; list-style: none; }
  .rec li { padding: 1.3mm 0; border-bottom: .5pt solid var(--phx-doc-hair); break-inside: avoid; page-break-inside: avoid; overflow-wrap: anywhere; }
  .rec li .t { display: block; color: var(--phx-doc-deep); font-weight: 700; }
  .rec li .t i { color: var(--phx-doc-muted); font-size: 8pt; font-style: normal; font-weight: 400; }
  .rec li .l { display: block; color: var(--phx-doc-muted); font-size: 8.3pt; }
  .rec li .at { display: block; color: var(--phx-doc-muted); font-size: 7.4pt; }
  .rec li .body { display: block; margin-top: .6mm; color: var(--phx-doc-body); }
  .rec .say { margin: 1.4mm 0 0; color: var(--phx-doc-muted); font-size: 8.4pt; overflow-wrap: anywhere; }
  .rec .say--problem { color: var(--phx-doc-deep); font-weight: 700; }
  .rec .para { margin: 1.6mm 0 0; }
`;
}
