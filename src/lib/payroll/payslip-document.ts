// The payslip, as a document — SATO-DIS-2026-01 v1.0.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE AND NOT TWO ROUTES. The payslip had two renderers that agreed on nothing but
// the numbers: an HTML sheet in `app/api/payroll/[id]/payslips/route.ts`, and a second, hand-drawn
// pdf-lib sheet in `.../payslips/image/route.ts` with its own private palette, its own field order
// and its own truncation. Two drawings of one document drift, and the drift is silent because
// nobody opens both in the same afternoon. There is now ONE document; the PDF route prints this
// exact HTML through Chromium, the same way the hiring papers are filed.
//
// That also fixes two things the pdf-lib sheet could not do at all. It could not draw Arabic —
// `StandardFonts.Helvetica` is WinAnsi, which is why that file carried an `asciiSafe()` that
// stripped every non-Latin character — and it truncated any value too wide for its column with
// "..", against the owner's standing rule that text is never cut with an ellipsis. Chromium wraps.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE HOUSE RULES THIS DOCUMENT IS BOUND BY, each of which the previous design broke:
//
//   THE MARK is Sato Pharma's, never Phoenix's. The old sheet carried `phoenix-main-logo.png`; a
//   payslip is a company document and wears the company's identity. The app's brand belongs on the
//   app's screens.
//
//   SQUARE EDGES, everywhere (owner, 2026-09-04). The old sheet had an 18 px page, 14 px cards and
//   a 999 px status pill. `border-radius: 0 !important` below is deliberate belt-and-braces: this
//   document is rendered inside a route that may one day sit under a global stylesheet, and a 4 px
//   radius inherited from `tokens.css` is invisible in review and still a breach.
//
//   THE INK RULE. Colour is carried by LINES AND TYPE, never by filled area. The old sheet spent
//   most of its ink on a navy→rust gradient masthead, six reversed-out section bands, three tinted
//   total rows and a solid navy tile. The only filled element here is the 6 % zebra row the owner
//   asked for by name, and it REPLACES the row hairline rather than joining it.
//
//   NO HORIZONTAL SCROLL, mobile and desktop both. The old sheet was a 960 px card with an inner
//   `overflow-y: auto` detail table; this is a 210 mm sheet that reflows to one column below 800 px.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SECTION-TO-REGION MAP IS ASSERTED AT RUNTIME, not merely typed. `payrollSheetSections` is
// positional over `payrollSheetHeaders`, and a new band added there would otherwise land nowhere
// and print nothing — silently, because `ignoreBuildErrors` lets a missing key compile, build and
// deploy. `assertEverySectionIsPlaced()` is called by the test suite and names the offender.

import { spellEgyptianAmount } from "@/lib/hiring-pack/arabic-amount";
import { HOUSE_IDENTITY_CSS, houseLetterhead } from "@/lib/hiring-pack/house-identity";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { systemLegalEntity } from "@/config/system-settings";
import {
  formatWorkingDays,
  payrollMoneyHeaders,
  payrollSheetHeaders,
  payrollSheetSections,
  payrollSheetValue,
  type PayrollSheetHeader,
  type PayrollSheetSection,
} from "@/lib/payroll/salary-sheet-fields";
import type { SalaryBatch, SalaryRecord } from "@/lib/payroll/types";

// ─── the vocabulary the route and the PDF both need ───────────────────────────

export function periodLabel(month: number, year: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export function isPublishedPayslipStatus(status: string) {
  return status === "approved" || status === "locked";
}

export function payslipStatusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatEGP(value: number) {
  return new Intl.NumberFormat("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(Number(value ?? 0));
}

/**
 * A date the way the rest of the document reads it.
 *
 * A bare `YYYY-MM-DD` is parsed as UTC ON PURPOSE and formatted in UTC. A hire date is a DATE-ONLY
 * column, not an instant: rendering it in Cairo would shift it to the previous calendar day for
 * anyone whose row was written as midnight, which is the trap catalogued for `timeZone: "UTC"`
 * sites — UTC is what STOPS the day moving here, and Cairo would be the bug.
 */
function formatDate(value: string | null) {
  if (!value) return "-";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = dateOnly
    ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

/**
 * The columns that do NOT appear in the component tables.
 *
 * Every one of these is printed somewhere else on the sheet — the identity block, the letterhead, or
 * the payment band — so listing them here is about avoiding a second appearance, never about hiding
 * a figure. "Working Days" joins Hire Date for the same reason it did before: the tables are lists
 * of money lines and a day count is not one.
 */
const IDENTITY_HEADERS = new Set<PayrollSheetHeader>([
  "#",
  "Month",
  "Year",
  "HR_ID",
  "Full Name",
  "Arabic Name",
  "Job Title",
  "Line",
  "Area",
  "Hire Date",
  "Working Days",
  "Payment Group",
  "Policy Comment",
]);

/**
 * Where each band of the payroll sheet is drawn.
 *
 * `left` and `right` are the two detail columns; `band` is the payment strip under them, which is
 * why "Payment Split" no longer appears as a table section — Month Salary, First Part and Second
 * Part are printed once, in the strip, instead of twice as they were before. `identity` is the
 * employee block at the top, whose columns are all in `IDENTITY_HEADERS` above.
 */
type PayslipRegion = "identity" | "left" | "right" | "band";

const REGION_BY_TONE: Record<PayrollSheetSection["tone"], PayslipRegion> = {
  additions: "left",
  deductions: "right",
  employee: "identity",
  fixed: "left",
  governmental: "right",
  payment: "band",
};

/**
 * Every band in `payrollSheetSections` has a home on the sheet.
 *
 * Called by the registered test, not at import time: this is a developer error, and throwing on
 * import would take down a payroll page in production over a mapping a test can catch in CI.
 */
export function assertEverySectionIsPlaced(): void {
  for (const section of payrollSheetSections) {
    if (!REGION_BY_TONE[section.tone]) {
      throw new Error(
        `The payroll sheet band "${section.label}" (tone "${section.tone}") has no region on the `
          + "payslip, so every column in it would print nowhere. Add it to REGION_BY_TONE.",
      );
    }
  }
}

/** The rows of one band, already formatted, in sheet order. */
function bandRows(
  section: PayrollSheetSection,
  record: SalaryRecord,
  month: number,
  year: number,
  index: number,
) {
  return payrollSheetHeaders
    .slice(section.start - 1, section.end)
    .filter((header) => !IDENTITY_HEADERS.has(header))
    .map((header) => ({
      header,
      // A total line is one whose own name says so, plus the governmental subtotal, which the sheet
      // names after its band rather than "Total …".
      isTotal:
        header.startsWith("Total ") || header === "Governmental Deductions",
      // A non-money column can still be a number (a day count), so it is stringified before
      // escaping rather than being handed to `escapeHtml` as `string | number`.
      value: payrollMoneyHeaders.has(header)
        ? formatEGP(Number(payrollSheetValue(record, month, year, index, header) ?? 0))
        : escapeHtml(String(payrollSheetValue(record, month, year, index, header) || "-")),
    }));
}

function sectionsFor(region: PayslipRegion) {
  return payrollSheetSections.filter((section) => REGION_BY_TONE[section.tone] === region);
}

function detailColumn(
  heading: string,
  region: PayslipRegion,
  record: SalaryRecord,
  month: number,
  year: number,
  index: number,
) {
  const bodies = sectionsFor(region)
    .map((section) => {
      const rows = bandRows(section, record, month, year, index);
      if (rows.length === 0) return "";
      const cells = rows
        .map(
          (row) => `<tr${row.isTotal ? ' class="sum"' : ""}>`
            + `<td>${escapeHtml(row.header)}</td>`
            + `<td class="num">${row.value}</td></tr>`,
        )
        .join("");
      return `<tbody>`
        + `<tr class="sec"><th colspan="2" scope="colgroup">`
        + `<span class="tick"></span>${escapeHtml(section.label)}</th></tr>`
        + `${cells}</tbody>`;
    })
    .join("");

  if (!bodies) return "";

  return `<div class="detail__col"><table class="cmp">
      <colgroup><col><col style="width:42%"></colgroup>
      <thead><tr><th scope="col">${escapeHtml(heading)}</th><th scope="col" class="num">Amount</th></tr></thead>
      ${bodies}
    </table></div>`;
}

// `value` is nullable because several of these columns are: `nameAr` is `string | null`, and a
// record with no Arabic name must print the same visible gap as any other empty cell rather than
// the word "null".
function idCell(label: string, value: string | null | undefined, arabic = false) {
  // `dir="rtl" lang="ar"` on the VALUE only. The employee's Arabic name is single-language free
  // text, so it gets its own direction and the English label beside it keeps LTR — the per-line
  // rule. A block-level `dir="auto"` here would read the label's first strong character and turn
  // the wrong half around.
  const dir = arabic ? ' dir="rtl" lang="ar"' : "";
  return `<div class="id__cell"><span class="id__k">${escapeHtml(label)}</span>`
    + `<span class="id__v"${dir}>${escapeHtml(value || "-")}</span></div>`;
}

function refCell(label: string, value: number) {
  return `<div class="ref__cell"><span class="ref__k">${escapeHtml(label)}</span>`
    + `<span class="ref__v">${formatEGP(value)}</span></div>`;
}

/** The figure named by a header, straight off the sheet, as a number. */
function sheetNumber(
  record: SalaryRecord,
  month: number,
  year: number,
  index: number,
  header: PayrollSheetHeader,
) {
  return Number(payrollSheetValue(record, month, year, index, header) ?? 0);
}

/**
 * One employee's payslip.
 *
 * Exported so a test can assert on what is actually EMITTED. Asserting on this module's source, or
 * on the data going in, is what lets a template-literal defect — an escaped slash, a quoted font
 * family closing an attribute — ship green.
 */
export function buildPayslipSheet(
  record: SalaryRecord,
  month: number,
  year: number,
  batchStatus: SalaryBatch["status"],
  index: number,
): string {
  const period = periodLabel(month, year);

  // The amount in words, by the same speller the employment contracts use. It returns "" for a
  // missing or zero amount ON PURPOSE — a spelled zero gets signed where an obvious gap gets
  // questioned — so an empty answer omits the line rather than printing "صفر جنيه".
  const words = spellEgyptianAmount(record.monthSalary);
  const wordsLine = words
    ? `<p class="hero__words" dir="rtl" lang="ar">${escapeHtml(`فقط ${words} لا غير`)}</p>`
    : "";

  // The payment strip is built FROM THE SHEET, labels included, so every cell carries the column's
  // own name. Writing "Month salary" by hand here is what a first draft did, and the sheet's actual
  // column then appeared nowhere on the document — caught by the registered test, not by reading.
  //
  // The month figure is pulled out and re-appended so it ends the strip, where it is set larger and
  // ruled heavier. If that column is ever renamed, `lead` is simply absent and all three print
  // plainly — a lost emphasis, never a lost figure.
  const bandFigures = sectionsFor("band").flatMap((section) =>
    bandRows(section, record, month, year, index),
  );
  const lead = bandFigures.find((row) => row.header === "Month Salary");
  const beforeLead = lead ? bandFigures.filter((row) => row !== lead) : bandFigures;

  const comment = record.payrollComment?.trim()
    ? `<section class="note"><h2>Comment</h2><p>${escapeHtml(record.payrollComment.trim())}</p></section>`
    : "";

  return `<article class="ps">
    ${houseLetterhead({
      legalNameAr: systemLegalEntity.legalNameAr,
      legalNameEn: systemLegalEntity.legalNameEn,
      purposeEn: "Employee copy · confidential",
      subtitleEn: `Salary statement · ${period}`,
      titleAr: "قسيمة راتب",
      titleEn: "Payslip",
    })}

    <section class="id">
      ${idCell("HR ID", record.employeeCode || record.hrId)}
      ${idCell("Employee", record.fullName)}
      ${idCell("Arabic name", record.nameAr, true)}
      ${idCell("Job title", record.jobTitle)}
      ${idCell("Line", record.line)}
      ${idCell("Area", record.area)}
      ${idCell("Hire date", formatDate(record.hireDate))}
      ${idCell("Working days", formatWorkingDays(record))}
      ${idCell("Batch status", payslipStatusLabel(batchStatus))}
    </section>

    <section class="hero">
      <div class="hero__head">
        <span class="hero__k">Month salary — total payable for ${escapeHtml(period)}</span>
        <span class="hero__v">${formatEGP(record.monthSalary)}</span>
      </div>
      ${wordsLine}
    </section>

    <section class="ref">
      ${refCell("Base salary", record.baseSalary)}
      ${refCell("Gross salary", record.grossSalary)}
      ${refCell("Net salary", record.netSalary)}
      ${refCell("Total additions", sheetNumber(record, month, year, index, "Total Additions"))}
      ${refCell("Total deductions", sheetNumber(record, month, year, index, "Total Deductions"))}
    </section>

    <section class="detail">
      ${detailColumn("Fixed salary and additions", "left", record, month, year, index)}
      ${detailColumn("Deductions", "right", record, month, year, index)}
    </section>

    <section class="split">
      ${beforeLead
        .map(
          (row) => `<div class="split__cell"><span class="split__k">${escapeHtml(row.header)}</span>`
            + `<span class="split__v">${row.value}</span></div>`,
        )
        .join("")}
      ${lead
        ? `<div class="split__cell split__cell--lead">`
          + `<span class="split__k">${escapeHtml(lead.header)}</span>`
          + `<span class="split__v">${lead.value}</span></div>`
        : ""}
    </section>

    ${comment}

    <footer class="ft">
      <span>${escapeHtml(record.employeeCode || record.hrId)} · ${escapeHtml(period)}
        · computer-generated statement, no signature required</span>
      <span class="ft__id">SATO-DIS-2026-01 v1.0</span>
    </footer>
  </article>`;
}

/**
 * The document's own stylesheet, on top of the house identity.
 *
 * Exported for the same reason the sheet builder is: a test asserts on the CSS that actually ships,
 * not on a description of it. The zebra row and the letterhead rule are the only painted areas in
 * here, and `tests/payslip-document.test.ts` counts them.
 */
export const PAYSLIP_DOCUMENT_CSS = `
${HOUSE_IDENTITY_CSS}

/* Square edges are not negotiable, and this document may be rendered under a stylesheet that ships
   a 4 px default. Nothing here sets a radius; this makes sure nothing inherits one either. */
*, *::before, *::after { box-sizing: border-box; border-radius: 0 !important; }

@page { size: A4; margin: 0; }

body {
  margin: 0;
  color: var(--phx-doc-body);
  font-family: "Segoe UI", Tahoma, Arial, sans-serif;
  font-size: 8.6pt;
  line-height: 1.42;
  font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.ps {
  background: #fff;
  width: 210mm;
  max-width: 100%;
  margin: 0 auto;
  padding: 10mm 13mm 9mm;
  page-break-after: always;
  break-after: page;
}
.ps:last-child { page-break-after: auto; break-after: auto; }
.ps h1, .ps h2, .ps p { margin: 0; }

/* On screen the sheet sits on a ground so its edges read as paper. On paper there is no ground. */
@media screen {
  body { background: #eef2f6; padding: 16px 0; }
  .ps { border: 1px solid var(--phx-doc-hair); margin-bottom: 16px; }
}

/* ---------- the employee, in ruled cells ---------- */
/* Cells, never panels: the same information for none of the toner. Values WRAP — a long name goes
   onto a second line and is never cut, because a shortened name cannot be told from a different
   one, and the ellipsis ban is the owner's. */
.id {
  display: flex; flex-wrap: wrap; margin: 3.5mm 0 0;
  border-top: .5pt solid var(--phx-doc-hair);
  border-inline-start: .5pt solid var(--phx-doc-hair);
}
.id__cell {
  flex: 1 1 52mm; min-width: 48mm; padding: 1.4mm 2.6mm;
  border-inline-end: .5pt solid var(--phx-doc-hair);
  border-bottom: .5pt solid var(--phx-doc-hair);
}
.id__k {
  display: block; margin-bottom: .4mm; color: var(--phx-doc-muted);
  font-size: 6.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
}
.id__v { display: block; color: var(--phx-doc-body); font-size: 9pt; font-weight: 600; overflow-wrap: anywhere; }

/* ---------- the figure the employee opened this for ---------- */
.hero {
  margin: 4mm 0 0; padding: 2.4mm 0 2mm;
  border-top: .7mm solid var(--phx-doc-blue);
  border-bottom: .5pt solid var(--phx-doc-hair);
}
.hero__head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 3mm; }
.hero__k { color: var(--phx-doc-deep); font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; }
.hero__v { color: var(--phx-doc-deep); font-size: 20pt; font-weight: 700; line-height: 1; letter-spacing: -.01em; }
.hero__words {
  margin-top: 1.8mm; padding-top: 1.4mm; border-top: .5pt solid var(--phx-doc-hair);
  color: var(--phx-doc-muted); font-size: 8.4pt; font-weight: 600; line-height: 1.6;
}

/* ---------- the five reference figures ---------- */
.ref { display: flex; flex-wrap: wrap; border-bottom: .5pt solid var(--phx-doc-hair); }
.ref__cell { flex: 1 1 32mm; min-width: 30mm; padding: 1.6mm 2.6mm; border-inline-start: .5pt solid var(--phx-doc-hair); }
.ref__cell:first-child { border-inline-start: 0; padding-inline-start: 0; }
.ref__k { display: block; color: var(--phx-doc-muted); font-size: 6.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.ref__v { display: block; margin-top: .5mm; color: var(--phx-doc-body); font-size: 10pt; font-weight: 700; overflow-wrap: anywhere; }

/* ---------- the detail, two balanced columns ---------- */
/* Earnings against deductions, so the whole payslip lands on ONE sheet instead of a single column
   of 27 rows running past the fold. Below 800 px they stack — this is the same document on a
   phone, never a horizontally scrolling one. */
.detail { display: flex; flex-wrap: wrap; gap: 0 8mm; margin: 3mm 0 0; align-items: flex-start; }
.detail__col { flex: 1 1 74mm; min-width: 70mm; }

.cmp { width: 100%; border-collapse: collapse; table-layout: fixed; }
.cmp th, .cmp td { padding: 1.2mm 2.2mm; text-align: start; vertical-align: top; overflow-wrap: anywhere; }
.cmp thead th {
  color: var(--phx-doc-deep); font-size: 7.4pt; font-weight: 700;
  text-transform: uppercase; letter-spacing: .08em;
  border-top: .5pt solid var(--phx-doc-blue);
  border-bottom: .5pt solid var(--phx-doc-blue);
  padding-top: 1.8mm; padding-bottom: 1.8mm;
}
.cmp .num { text-align: end; }

/* THE ONE FILLED ELEMENT ON THE PAGE — Brand Blue at 6 %, asked for by name. It REPLACES the row
   hairline rather than joining it, which is why no rule is drawn between body rows. */
.cmp tbody tr:nth-child(even) { background: var(--phx-doc-tint); }

.cmp .sec th {
  padding-top: 3.2mm; padding-bottom: 1.2mm; background: #fff;
  color: var(--phx-doc-deep); font-size: 7pt; font-weight: 700;
  text-transform: uppercase; letter-spacing: .1em;
  border-bottom: .5pt solid var(--phx-doc-hair);
}
/* A short lead rule in the wave's lightest stroke — the third brand colour, spent as a line. */
.cmp .tick { display: block; width: 8mm; height: 0; margin-bottom: 1.3mm; border-top: .6mm solid var(--phx-doc-light); }
.cmp tbody tr.sec:nth-child(even) { background: #fff; }

.cmp .sum td {
  font-weight: 700; color: var(--phx-doc-deep);
  border-top: .5pt solid var(--phx-doc-blue);
  border-bottom: .5pt solid var(--phx-doc-blue);
}
.cmp tbody tr.sum:nth-child(even) { background: #fff; }

.cmp thead { display: table-header-group; }
.cmp tr { break-inside: avoid; page-break-inside: avoid; }

/* ---------- how the month is actually paid ---------- */
.split { display: flex; flex-wrap: wrap; margin: 3mm 0 0; border-top: .5pt solid var(--phx-doc-hair); }
.split__cell {
  flex: 1 1 40mm; min-width: 38mm; padding: 2mm 2.6mm;
  border-inline-start: .5pt solid var(--phx-doc-hair);
  border-bottom: .5pt solid var(--phx-doc-hair);
}
.split__cell:first-child { border-inline-start: 0; padding-inline-start: 0; }
/* The month figure leads by WEIGHT and a heavier rule. It is not a filled tile, which is what it
   used to be. */
.split__cell--lead { border-bottom: .7mm solid var(--phx-doc-blue); }
.split__k { display: block; color: var(--phx-doc-muted); font-size: 6.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.split__v { display: block; margin-top: .5mm; color: var(--phx-doc-deep); font-size: 11.5pt; font-weight: 700; overflow-wrap: anywhere; }
.split__cell--lead .split__v { font-size: 13.5pt; }

.note { margin: 3mm 0 0; padding-inline-start: 2.8mm; border-inline-start: .5pt solid var(--phx-doc-hair); }
.note h2 { color: var(--phx-doc-deep); font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; }
.note p { margin-top: 1mm; color: var(--phx-doc-muted); font-size: 8pt; line-height: 1.55; }

.ft {
  display: flex; flex-wrap: wrap; gap: 1mm 4mm; justify-content: space-between;
  margin: 3.5mm 0 0; padding-top: 1.4mm;
  border-top: .5pt solid var(--phx-doc-hair);
  color: var(--phx-doc-muted); font-size: 6.8pt; letter-spacing: .02em;
}
.ft__id { color: var(--phx-doc-deep); font-weight: 700; }

.hero, .ref, .split, .note, .ft { break-inside: avoid; page-break-inside: avoid; }

/* ---------- the phone ---------- */
/* Scoped to screen, as a guard rather than a fix. A4 is 210 mm — 793.7 px at 96 dpi — and this
   breakpoint is 800 px, so paper sits SIX PIXELS inside a rule written for phones. Measured
   2026-09-05: Chromium's print layout does not currently apply it, and scoping this to screen
   changed the exported PDF by zero bytes. It is kept because six pixels is not a margin worth
   depending on, and because a future breakpoint moved a little wider would silently print every
   payslip in the stacked phone layout.
   This is NOT what made the export two pages — that was 11.1 mm of ordinary overflow, fixed by the
   spacing below. */
@media screen and (max-width: 800px) {
  .ps { padding: 7mm 5mm; }
  .id__cell { flex-basis: 100%; }
  .ref__cell { flex-basis: 50%; border-inline-start: 0; padding-inline-start: 0; border-bottom: .5pt solid var(--phx-doc-hair); }
  .detail__col { flex-basis: 100%; min-width: 0; }
  .detail__col + .detail__col { margin-top: 5mm; }
  .split__cell { flex-basis: 100%; border-inline-start: 0; padding-inline-start: 0; }
  .hero__v { font-size: 17pt; }
}
`;

/**
 * The whole printable document — one sheet per record.
 *
 * This is what the HTML route serves and what the PDF route hands to Chromium, so the two cannot
 * disagree about anything, ever.
 */
export function buildPayslipDocument(
  records: SalaryRecord[],
  month: number,
  year: number,
  batchStatus: SalaryBatch["status"],
): string {
  const sheets = records
    .map((record, index) => buildPayslipSheet(record, month, year, batchStatus, index + 1))
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(`Sato Pharma payslip — ${periodLabel(month, year)}`)}</title>
    <style>${PAYSLIP_DOCUMENT_CSS}</style>
  </head>
  <body>${sheets}</body>
</html>`;
}
