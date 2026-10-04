// The organogram employee record, as a document — SATO-DIS-2026-01 v1.0.
//
// WHAT THIS IS. Pressing a person on the organogram opens a popup of their record
// (`organogram-node-detail-modal.tsx`), fed by `/api/reports/organogram/employee/[hrId]`. This
// module turns that SAME payload into a printable house document, so "extract this record as a
// PDF" produces exactly what the popup shows — no second definition of the fields, no second set
// of permission rules. The PDF route hands the built HTML to Chromium the way the payslip and the
// hiring papers are filed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// IT MIRRORS THE POPUP, INCLUDING WHAT IT IS ALLOWED TO SHOW. The `OrganogramEmployeeDetail` is
// built server-side with the viewer's role already applied — a line manager's payload carries only
// the org + contact sections, an HR/finance/admin viewer additionally carries Personal and
// Compensation, and the Talent-Acquisition salary carve-out has already blanked the money. This
// document renders whatever sections it is handed and invents nothing, so the PDF can never reveal
// a field the popup would have hidden from the same person.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE HOUSE RULES THIS DOCUMENT IS BOUND BY (the payslip's siblings):
//
//   THE MARK is Sato Pharma's, carried by `houseLetterhead()`. The app's brand belongs on screens.
//   SQUARE EDGES everywhere — `border-radius: 0 !important`, belt-and-braces against a 4 px radius
//     inherited from `tokens.css` should this render under a global sheet.
//   THE INK RULE — colour is carried by LINES AND TYPE, never by filled area. The only backgrounds
//     here are white; there is no zebra because a record is label/value cells, not a money table.
//   NO ELLIPSIS — every value WRAPS (`overflow-wrap: anywhere`); a cut name cannot be told from a
//     different one, and the ellipsis ban is the owner's.
//   NO HORIZONTAL SCROLL — a 210 mm sheet that reflows to one column below 800 px on screen.

import { HOUSE_IDENTITY_CSS, houseLetterhead } from "@/lib/hiring-pack/house-identity";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { systemLegalEntity } from "@/config/system-settings";
import type {
  OrganogramDetailSection,
  OrganogramEmployeeDetail,
} from "@/lib/reports/organogram-employee-detail";

/** One label/value cell. The value WRAPS; empty cells are dropped, never shown as "—" on paper. */
function cell(label: string, value: string | null): string {
  if (!value || !value.trim()) return "";
  return `<div class="rec__cell">`
    + `<span class="rec__k">${escapeHtml(label)}</span>`
    + `<span class="rec__v">${escapeHtml(value)}</span></div>`;
}

/**
 * One section, as a titled block of ruled cells.
 *
 * A section with nothing populated is dropped entirely — the same rule the popup's `SectionGrid`
 * applies, so a person with no compensation figures does not get an empty "Compensation" heading.
 */
function section(part: OrganogramDetailSection): string {
  const cells = part.items.map((item) => cell(item.label, item.value)).filter(Boolean).join("");
  if (!cells) return "";
  return `<section class="rec__section">`
    + `<h2 class="rec__h"><span class="rec__tick"></span>${escapeHtml(part.title)}</h2>`
    + `<div class="rec__grid">${cells}</div></section>`;
}

/**
 * One employee's record sheet.
 *
 * Exported so a test can assert on what is actually EMITTED — a template-literal defect (an escaped
 * slash, a quoted font family closing an attribute) ships green when a test reads the source instead.
 */
export function buildOrganogramEmployeeRecordSheet(detail: OrganogramEmployeeDetail): string {
  const subtitleParts = [detail.jobTitle, detail.areaName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const subtitleEn = subtitleParts.length > 0 ? subtitleParts.join(" · ") : null;

  const sections = detail.sections.map(section).filter(Boolean).join("");

  return `<article class="rec">
    ${houseLetterhead({
      legalNameAr: systemLegalEntity.legalNameAr,
      legalNameEn: systemLegalEntity.legalNameEn,
      purposeEn: "Confidential · HR record",
      subtitleEn,
      titleAr: "بيانات الموظف",
      titleEn: "Employee Record",
    })}

    <section class="rec__id">
      <div class="rec__id-cell"><span class="rec__k">Employee</span>
        <span class="rec__id-name">${escapeHtml(detail.fullName || detail.displayName)}</span></div>
      <div class="rec__id-cell"><span class="rec__k">HR ID</span>
        <span class="rec__id-code">${escapeHtml(detail.hrId)}</span></div>
    </section>

    ${sections}

    <footer class="rec__ft">
      <span>${escapeHtml(detail.hrId)} · computer-generated record · confidential</span>
      <span class="rec__ft-id">SATO-DIS-2026-01 v1.0</span>
    </footer>
  </article>`;
}

/**
 * The document's own stylesheet, on top of the house identity.
 *
 * Exported for the same reason the sheet builder is: a test asserts on the CSS that actually ships.
 * There is no painted area here beyond white — the record is ruled cells, not a money table, so it
 * carries no zebra row. That keeps it inside the ink rule with nothing to count.
 */
export const ORGANOGRAM_RECORD_CSS = `
${HOUSE_IDENTITY_CSS}

/* Square edges are not negotiable, and this may render under a stylesheet shipping a 4 px default. */
*, *::before, *::after { box-sizing: border-box; border-radius: 0 !important; }

@page { size: A4; margin: 0; }

body {
  margin: 0;
  color: var(--phx-doc-body);
  font-family: "Segoe UI", Tahoma, Arial, sans-serif;
  font-size: 8.8pt;
  line-height: 1.42;
  font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.rec {
  background: #fff;
  width: 210mm;
  max-width: 100%;
  margin: 0 auto;
  padding: 10mm 13mm 9mm;
}
.rec h1, .rec h2, .rec p { margin: 0; }

/* On screen the sheet sits on a ground so its edges read as paper. On paper there is no ground. */
@media screen {
  body { background: #eef2f6; padding: 16px 0; }
  .rec { border: 1px solid var(--phx-doc-hair); }
}

/* ---------- the person, named once at the top ---------- */
.rec__id {
  display: flex; flex-wrap: wrap; margin: 3.5mm 0 0;
  border-top: .5pt solid var(--phx-doc-hair);
  border-inline-start: .5pt solid var(--phx-doc-hair);
}
.rec__id-cell {
  flex: 1 1 70mm; min-width: 60mm; padding: 1.6mm 2.6mm;
  border-inline-end: .5pt solid var(--phx-doc-hair);
  border-bottom: .5pt solid var(--phx-doc-hair);
}
.rec__id-name { display: block; margin-top: .5mm; color: var(--phx-doc-deep); font-size: 12pt; font-weight: 700; overflow-wrap: anywhere; }
.rec__id-code { display: block; margin-top: .5mm; color: var(--phx-doc-body); font-family: Consolas, ui-monospace, monospace; font-size: 10pt; font-weight: 700; overflow-wrap: anywhere; }

/* ---------- each section, a heading and ruled cells ---------- */
.rec__section { margin: 4mm 0 0; break-inside: avoid; page-break-inside: avoid; }
.rec__h {
  color: var(--phx-doc-deep); font-size: 7.6pt; font-weight: 700;
  text-transform: uppercase; letter-spacing: .1em;
  padding-bottom: 1.4mm; border-bottom: .5pt solid var(--phx-doc-blue);
}
/* A short lead rule in the wave's lightest stroke — the third brand colour, spent as a line. */
.rec__tick { display: inline-block; width: 6mm; height: 0; margin-inline-end: 2mm; vertical-align: middle; border-top: .6mm solid var(--phx-doc-light); }

.rec__grid {
  display: flex; flex-wrap: wrap;
  border-inline-start: .5pt solid var(--phx-doc-hair);
}
.rec__cell {
  flex: 1 1 52mm; min-width: 48mm; padding: 1.4mm 2.6mm;
  border-inline-end: .5pt solid var(--phx-doc-hair);
  border-bottom: .5pt solid var(--phx-doc-hair);
}
.rec__k {
  display: block; margin-bottom: .4mm; color: var(--phx-doc-muted);
  font-size: 6.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
}
.rec__v { display: block; color: var(--phx-doc-body); font-size: 9pt; font-weight: 600; overflow-wrap: anywhere; }

.rec__ft {
  display: flex; flex-wrap: wrap; gap: 1mm 4mm; justify-content: space-between;
  margin: 4mm 0 0; padding-top: 1.4mm;
  border-top: .5pt solid var(--phx-doc-hair);
  color: var(--phx-doc-muted); font-size: 6.8pt; letter-spacing: .02em;
}
.rec__ft-id { color: var(--phx-doc-deep); font-weight: 700; }

/* ---------- the phone: one column, never a horizontal scroll ---------- */
@media screen and (max-width: 800px) {
  .rec { padding: 7mm 5mm; }
  .rec__id-cell { flex-basis: 100%; }
  .rec__cell { flex-basis: 100%; }
}
`;

/**
 * The whole printable document — one record sheet.
 *
 * This is what the PDF route hands to Chromium.
 */
export function buildOrganogramEmployeeDocument(detail: OrganogramEmployeeDetail): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(`Employee record — ${detail.fullName || detail.displayName}`)}</title>
    <style>${ORGANOGRAM_RECORD_CSS}</style>
  </head>
  <body>${buildOrganogramEmployeeRecordSheet(detail)}</body>
</html>`;
}

/**
 * The saved file's name: "Ahmed Mohamed - employee record.pdf". The person leads, and the person
 * is a NAME — the same format and reasoning as `payslipFileName`. Spaces are kept; only the
 * filesystem-illegal set and leading dots are stripped. Falls back to the HR id, then the bare word.
 */
export function organogramRecordFileName(detail: Pick<OrganogramEmployeeDetail, "fullName" | "displayName" | "hrId">): string {
  const person = [detail.fullName, detail.displayName, detail.hrId]
    .map((value) => (value ?? "").trim())
    .find((value) => value !== "");

  const cleaned = (person ?? "")
    // C0 controls, DEL, and the set Windows refuses in a filename — spelled with explicit escapes.
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();

  return `${cleaned || "Employee"} - employee record.pdf`;
}

/**
 * The whole `Content-Disposition` header for the record download.
 *
 * BOTH FORMS, in the order RFC 6266 specifies — the quoted ASCII fallback every browser understands,
 * and the UTF-8 `filename*=` for the ones that read it, so an Arabic name never arrives as mojibake.
 * The ASCII fallback is built by running the same namer over an ASCII-reduced record, so an
 * Arabic-only name degrades to its HR id rather than to a file that opens with a dash — the same
 * reasoning as `payslipContentDisposition`.
 */
export function organogramRecordContentDisposition(
  detail: Pick<OrganogramEmployeeDetail, "fullName" | "displayName" | "hrId">,
): string {
  const fileName = organogramRecordFileName(detail);
  const ascii = (value: string) =>
    (value ?? "").replace(/[^\u0020-\u007E]/g, "").replace(/["\\]/g, "").trim();
  const asciiFallback = organogramRecordFileName({
    fullName: ascii(detail.fullName),
    displayName: ascii(detail.displayName),
    hrId: ascii(detail.hrId),
  });
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
