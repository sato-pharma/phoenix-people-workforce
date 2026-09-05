// The Monthly Closing sheet, as a PDF the server renders.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. The premium workbook ships as `.xlsm` so the owner's button bar is live, and
// `PhxExportPdf` is the button on it he uses most. A `.xlsx` cannot hold code — the format forbids a
// VBA part outright — so the macro-free build lost that button and there is no Excel feature that
// puts it back: Power Query cannot write a file, Office Scripts has no PDF API and needs a
// Microsoft 365 tenant this company does not have, and an Excel 4.0 macro sheet is barred from
// `.xlsx` for the same reason VBA is. What a `.xlsx` CAN carry is a hyperlink, so the button becomes
// a link and the PDF is rendered here instead of inside Excel.
//
// ONE SHEET PER RENDER, because that is what the macro does: `PhxExportPdf` exports `ActiveSheet`,
// not the workbook. Each page therefore carries its own link and the reader gets the page they were
// looking at, which is the behaviour they already know.
//
// THE NUMBERS COME FROM THE FILL, never from a second query. `buildClosingEngineFill` is what writes
// the workbook, and this renders the rows it produced — so the PDF, the `.xlsx` and the closing
// screen cannot disagree. The column headings come from the owner's own template, read out of it at
// render time rather than retyped here, for the same reason.

import JSZip from "jszip";

import { HOUSE_COLORS, HOUSE_IDENTITY_CSS } from "@/lib/hiring-pack/house-identity";
import { satoLogoDataUri } from "@/lib/offers/brand";
import { withChromiumPage } from "@/lib/pdf/chromium";

import type { ClosingEngineFill, EngineValue } from "./closing-engine-fill";
import {
  CLOSING_ENGINE_TEMPLATE_MANIFEST,
  closingEngineTemplateBytes,
} from "./closing-engine-template-generated";

/**
 * The sheets a reader can ask for.
 *
 * A SET OF THE ONES THAT RENDER, never a list of the ones that do not — a sheet added to the engine
 * later is then excluded until somebody decides it belongs here, rather than reaching the reader as
 * a blank page. Two kinds are absent on purpose:
 *
 *  - `Data` is the hidden source block the pivots and the Rep Card read. It is not a page.
 *  - `Closing Matrix`, `Units Matrix` and `Area x Product` are PIVOTS. Excel materialises their grid
 *    itself when the workbook opens, so the fill carries a title for them and no rows at all —
 *    there is nothing here to render, and a page built from `SalesData` instead would be a second
 *    implementation of a pivot that could drift from the one in the workbook.
 *  - `Rep Card` is a formula sheet driven by a dropdown. A PDF has no dropdown.
 */
export const CLOSING_PDF_SHEETS = [
  "Overview",
  "Rep Ranking",
  "Top Achievers",
  "Family Performance",
  "Family by Month",
  "Watch List",
  "Top Customers",
  "Details",
] as const;

export type ClosingPdfSheet = (typeof CLOSING_PDF_SHEETS)[number];

export function isClosingPdfSheet(name: string): name is ClosingPdfSheet {
  return (CLOSING_PDF_SHEETS as readonly string[]).includes(name);
}

type TemplateSheetSpec = {
  file: string;
  kind: string;
  firstDataRow?: number | null;
};

const MANIFEST = CLOSING_ENGINE_TEMPLATE_MANIFEST as unknown as {
  sheets: Record<string, TemplateSheetSpec>;
};

/** One `<row>`, self-closing or paired. Rows never nest, so the first `</row>` is this one's. */
const ROW = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
/** One `<c>`, in either form. The paired form's body is where an inline string sits. */
const CELL = /<c\b[^>]*?r="[A-Z]+\d+"[^>]*?>([\s\S]*?)<\/c>|<c\b[^>]*?r="[A-Z]+\d+"[^>]*?\/>/g;

/**
 * The column headings and the page orientation, read out of the owner's template.
 *
 * BOTH ARE HIS, not ours. Retyping the headings here would let the PDF and the workbook drift apart
 * the first time he renames a column, and picking an orientation would let a wide table land on
 * portrait paper — the template already says which sheets are landscape, because `PhxExportPdf`
 * wrote that setting and Excel saved it.
 *
 * The engine template stores its strings INLINE (`t="inlineStr"`), not in `sharedStrings.xml`, which
 * is empty — measured, not assumed. A reader written against the shared-string table finds nothing
 * and reports every sheet as having no headings.
 */
export async function readSheetChrome(
  sheet: ClosingPdfSheet,
): Promise<{ headers: string[]; landscape: boolean }> {
  const spec = MANIFEST.sheets[sheet];
  if (!spec?.firstDataRow) throw new Error(`no template spec for the ${sheet} sheet`);

  const zip = await JSZip.loadAsync(closingEngineTemplateBytes());
  const xml = await zip.file(spec.file)?.async("string");
  if (!xml) throw new Error(`the closing engine template is missing ${spec.file}`);

  const wanted = spec.firstDataRow - 1;
  let headers: string[] = [];
  for (const row of xml.match(ROW) ?? []) {
    if (Number(/<row\b[^>]*\br="(\d+)"/.exec(row)?.[1] ?? -1) !== wanted) continue;
    headers = [...row.matchAll(CELL)].map((cell) =>
      [...(cell[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("").trim(),
    );
    break;
  }

  // Trailing blanks are real cells the owner styled but left empty — they carry no column and would
  // print as empty headings over nothing. Leading and interior blanks are kept: a gap in the middle
  // is a column the rows still fill.
  while (headers.length > 0 && headers[headers.length - 1] === "") headers.pop();

  return {
    headers: headers.map(unescapeXml),
    landscape: /<pageSetup\b[^>]*orientation="landscape"/.test(xml),
  };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Which columns are a proportion rather than money.
 *
 * Read off the HEADING, because the heading is the only thing that travels with the value: the fill
 * hands over a bare number, and the workbook's own percent formatting lives in a cell style this
 * module never sees. `0.83` printed as `0.83` where the sheet says `83%` is the failure this avoids,
 * and it is a silent one — the figure is not wrong, it is unreadable.
 */
function isProportionColumn(heading: string): boolean {
  return /^(achievement|share\b|share of|against the month before|running share)/i.test(heading.trim());
}

/** Whole numbers with thousands separators — the owner reads money without decimals. */
const INTEGER = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 0 });

function formatCell(value: EngineValue, heading: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    if (isProportionColumn(heading)) return `${PERCENT.format(value * 100)}%`;
    return INTEGER.format(value);
  }
  return String(value);
}

/** A number column is right-aligned; a name column is not. Decided by the value, not the heading. */
function isNumeric(value: EngineValue): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The document's own stylesheet, on top of the house identity.
 *
 * SQUARE EDGES EVERYWHERE — the owner's rule of 2026-09-04, and `tokens.css` is no help here because
 * it is the app's screen system and ships a 4 px default radius. Nothing in this document sets one.
 *
 * THE INK RULE: no filled areas. The table is carried by hairlines and by the 6% zebra row, which is
 * the one filled element the owner asked for by name. The heading row is ruled top and bottom rather
 * than reversed out of a solid band.
 *
 * WRAPPING, NEVER AN ELLIPSIS. A client name or an address that outruns its column wraps onto a
 * second line; `text-overflow` appears nowhere. Truncating a customer's name is the one thing this
 * document must not do, because the reader cannot tell a shortened name from a different one.
 */
function documentCss(landscape: boolean): string {
  return `
  ${HOUSE_IDENTITY_CSS}

  @page {
    size: A4 ${landscape ? "landscape" : "portrait"};
    margin: ${landscape ? "10mm 6mm" : "7mm 9mm"};
  }

  * { box-sizing: border-box; border-radius: 0 !important; }

  body {
    margin: 0;
    color: var(--phx-doc-body);
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    font-size: 8.2pt;
    line-height: 1.35;
  }

  .rpt__title { margin: 3mm 0 1mm; color: var(--phx-doc-deep); font-size: 13pt; font-weight: 700; }
  .rpt__sub { margin: 0 0 2.5mm; color: var(--phx-doc-muted); font-size: 8pt; font-weight: 600; }

  /* The KPI strip. Ruled cells, never tinted panels — same information, a fraction of the toner. */
  .kpi { display: flex; flex-wrap: wrap; gap: 0; margin: 0 0 3mm; border-top: .5pt solid var(--phx-doc-hair); border-bottom: .5pt solid var(--phx-doc-hair); }
  .kpi__cell { flex: 1 1 0; min-width: 28mm; padding: 1.6mm 2.4mm; border-inline-start: .5pt solid var(--phx-doc-hair); }
  .kpi__cell:first-child { border-inline-start: 0; }
  .kpi__k { display: block; color: var(--phx-doc-muted); font-size: 6.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .kpi__v { display: block; color: var(--phx-doc-deep); font-size: 10.5pt; font-weight: 700; }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding: 1.15mm 1.6mm; text-align: start; vertical-align: top; overflow-wrap: anywhere; }
  thead th {
    color: var(--phx-doc-deep); font-size: 7.2pt; font-weight: 700;
    text-transform: uppercase; letter-spacing: .03em;
    border-top: .5pt solid var(--phx-doc-blue);
    border-bottom: .5pt solid var(--phx-doc-blue);
  }
  tbody tr:nth-child(even) { background: var(--phx-doc-tint); }
  td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; }

  /* The heading row repeats on every page; a row never breaks across two. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }

  .rpt__notes { margin: 3mm 0 0; padding: 0; list-style: none; color: var(--phx-doc-muted); font-size: 7pt; }
  .rpt__notes li { margin: .6mm 0; padding-inline-start: 2.6mm; border-inline-start: .5pt solid var(--phx-doc-hair); }
  .rpt__empty { margin: 6mm 0; padding: 3mm; border: .5pt solid var(--phx-doc-hair); color: var(--phx-doc-muted); text-align: center; }
`;
}

export interface ClosingSheetPdfInput {
  fill: ClosingEngineFill;
  sheet: ClosingPdfSheet;
  /**
   * The line the workbook covers, for the running foot. Nullable because that is what the closing
   * matrix resolves to when a line has nothing uploaded — printed as a phrase rather than as the
   * word "null", which is the failure a cast at the call site would have produced.
   */
  line: string | null;
  /** The period key, `YYYY-MM`, or null when no month resolved. */
  period: string | null;
}

/** A line or month that did not resolve, said in words rather than left as an empty gap. */
function orUnknown(value: string | null, what: string): string {
  return value?.trim() ? value.trim() : `no ${what}`;
}

/**
 * The KPI figures a sheet wrote into its header block, as label/value pairs.
 *
 * The fill addresses these by cell reference (`B5`, `D5`, …) because that is where they land in the
 * workbook, and the label sits in the cell above or beside the figure — a geometry this document
 * does not have. Rather than re-derive the pairing, the strip is built only from the cells whose
 * label the fill supplies alongside them, and a sheet with none simply has no strip.
 */
function kpiStrip(cells: Record<string, EngineValue> | undefined): string {
  if (!cells) return "";
  // Row 5 and row 6 are the KPI band in this engine: row 5 holds the figures, row 6 their captions.
  const pairs: Array<{ k: string; v: string }> = [];
  for (const column of ["B", "D", "F", "I"]) {
    const value = cells[`${column}5`];
    const label = cells[`${column}6`];
    if (value === undefined || value === null || value === "") continue;
    pairs.push({
      k: label === undefined || label === null ? "" : String(label),
      v: typeof value === "number" ? INTEGER.format(value) : String(value),
    });
  }
  if (pairs.length === 0) return "";
  return `<div class="kpi">${pairs
    .map(
      (pair) =>
        `<div class="kpi__cell"><span class="kpi__k">${escapeHtml(pair.k)}</span><span class="kpi__v">${escapeHtml(pair.v)}</span></div>`,
    )
    .join("")}</div>`;
}

/**
 * The whole document, as one HTML string.
 *
 * Exported so a test can assert on what is actually EMITTED. Asserting on this module's source, or
 * on the shape of the data going in, is what lets a template-literal defect — an escaped slash that
 * reaches the browser unescaped, a quoted font family that closes an attribute — ship green.
 */
export function buildClosingSheetHtml(
  input: ClosingSheetPdfInput,
  chrome: { headers: string[]; landscape: boolean },
): string {
  const content = input.fill.sheets[input.sheet] ?? {};
  const rows = content.rows ?? [];
  const headers = chrome.headers;

  // A1 is one long string the owner writes as "Title · subtitle"; the sheet shows it in one merged
  // cell. Split on the separator he uses so the PDF can set the two at different weights, and fall
  // back to the sheet name when the fill left A1 alone.
  const a1 = String(content.cells?.A1 ?? "").trim();
  const [titleRaw, ...subParts] = a1.split(/\s+[·|]\s+/);
  const title = titleRaw || input.sheet;
  const subtitle = subParts.join(" · ");

  const body =
    rows.length === 0
      ? `<p class="rpt__empty">This sheet has no rows for ${escapeHtml(orUnknown(input.period, "month"))}.</p>`
      : `<table>
      <thead><tr>${headers
        .map((heading, index) => {
          const numeric = rows.some((row) => isNumeric(row[index]));
          return `<th${numeric ? ' class="num"' : ""}>${escapeHtml(heading)}</th>`;
        })
        .join("")}</tr></thead>
      <tbody>${rows
        .map(
          (row) =>
            `<tr>${headers
              .map((heading, index) => {
                const value = row[index] ?? null;
                return `<td${isNumeric(value) ? ' class="num"' : ""}>${escapeHtml(formatCell(value, heading))}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")}</tbody>
    </table>`;

  const notes = (content.notes ?? []).filter((note) => String(note).trim() !== "");
  const notesHtml =
    notes.length === 0
      ? ""
      : `<ul class="rpt__notes">${notes.map((note) => `<li>${escapeHtml(String(note))}</li>`).join("")}</ul>`;

  const mark = satoLogoDataUri();
  // The mark rides in the letterhead, not on the sheet. On the Excel pages the emblem is now
  // suppressed from printing because each sheet's own A1 title already names the company — here the
  // document has no such title block of its own, so this is the only thing identifying the paper.
  const letterhead = `<header class="lh">
      <div class="lh__mark">${mark ? `<img src="${mark}" alt="">` : ""}</div>
      <div class="lh__id"><strong>Sato Pharma</strong><span dir="ltr">Monthly Closing</span></div>
    </header>
    <div class="lh__rule"></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`${title} — ${orUnknown(input.line, "line")} ${orUnknown(input.period, "month")}`)}</title>
<style>${documentCss(chrome.landscape)}</style></head>
<body>
${letterhead}
<h1 class="rpt__title">${escapeHtml(title)}</h1>
${subtitle ? `<p class="rpt__sub">${escapeHtml(subtitle)}</p>` : ""}
${kpiStrip(content.cells)}
${body}
${notesHtml}
</body></html>`;
}

/**
 * The running foot: who the paper is for, and which page of how many.
 *
 * Chromium demands a non-empty element for both templates — handed `""` it falls back to its own
 * default header, which prints the document title and today's date across the top of the page. The
 * header is therefore an empty span rather than nothing.
 */
function footerTemplate(line: string | null, period: string | null): string {
  return `<div style="width:100%;padding:0 9mm;font-family:'Segoe UI',Tahoma,Arial,sans-serif;font-size:6.6pt;color:${HOUSE_COLORS.muted};display:flex;justify-content:space-between;">
    <span>${escapeHtml(`${orUnknown(line, "line")} · ${orUnknown(period, "month")}`)}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
}

/**
 * Render one sheet to PDF.
 *
 * `emulateMediaType("print")` is not optional: Chromium applies `@media screen` by default even when
 * producing a PDF, so a print-only rule would be ignored and the zebra row — a background, which
 * print styling normally suppresses — is exactly the kind of thing that then differs between what
 * this returns and what the reader sees.
 */
export async function renderClosingSheetPdf(input: ClosingSheetPdfInput): Promise<Buffer> {
  const chrome = await readSheetChrome(input.sheet);
  const html = buildClosingSheetHtml(input, chrome);

  return withChromiumPage(async (page) => {
    await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      displayHeaderFooter: true,
      footerTemplate: footerTemplate(input.line, input.period),
      format: "A4",
      headerTemplate: "<span></span>",
      landscape: chrome.landscape,
      // The margins live in the `@page` rule so the two cannot disagree; `printBackground` is what
      // carries the zebra row through, and without it the one filled element the owner asked for
      // silently does not print.
      preferCSSPageSize: true,
      printBackground: true,
    });
    return Buffer.from(pdf);
  });
}

/**
 * The Rep Card sheet, which the generic table renderer above cannot draw.
 *
 * It is not a table: it is one person's month, and the sheet shows exactly one of them at a time,
 * chosen from a dropdown. That is why it is kept out of `CLOSING_PDF_SHEETS` — asking for it needs
 * an area code, and a request without one has no card to render.
 */
export const REP_CARD_SHEET = "Rep Card";

/** The `AreaBook` block on the hidden Data sheet, by position. Verified against a real export. */
const AREA = {
  label: 0, code: 1, area: 2, region: 3, rep: 4, manager: 5,
  sales: 6, target: 7, targetedSales: 8, achievement: 9, rank: 10, prior: 11,
} as const;

/** The `SalesData` block, by position. Same source, same verification. */
const SALES = {
  region: 0, area: 1, code: 2, rep: 3, manager: 4, product: 5,
  units: 6, targetUnits: 7, targetedUnits: 8, sales: 9, target: 10, targetedSales: 11, prior: 12, status: 13,
} as const;

export interface RepCardPdfInput {
  fill: ClosingEngineFill;
  /** The area whose card to draw — the code the sheet's own dropdown resolves to. */
  areaCode: string;
  line: string | null;
  period: string | null;
}

/** The area's row in the AreaBook, matched case-insensitively — HR and area codes are mixed case. */
export function findAreaRow(fill: ClosingEngineFill, areaCode: string): EngineValue[] | null {
  const wanted = areaCode.trim().toUpperCase();
  if (!wanted) return null;
  return (
    fill.data.areaBook.find((row) => String(row[AREA.code] ?? "").trim().toUpperCase() === wanted) ?? null
  );
}

/**
 * One rep's card, as HTML.
 *
 * Exported so a test can assert on what is EMITTED rather than on this module's source.
 *
 * THE PAGE IS THE DESIGN. The first draft put everything in the top third and left two thirds of an
 * A4 sheet blank, which reads as a fragment rather than a document however well the top third is
 * drawn. So the card is built as a full page: a hero, a gauge that carries the one number this sheet
 * exists to state, the supporting figures beside it, the month-on-month comparison drawn rather than
 * described, and the product detail given room to breathe.
 *
 * COLOUR AND FILL ARE DELIBERATE, and this is the one document that departs from the house INK RULE.
 * The owner asked for it by name. That rule's reason is toner on papers printed in volume — a
 * contract in triplicate, a custody receipt per device — and this is a single-page report read mostly
 * on screen. Every other document keeps the rule; government forms remain exempt permanently.
 */
export function buildRepCardHtml(input: RepCardPdfInput): string {
  const row = findAreaRow(input.fill, input.areaCode);
  const mark = satoLogoDataUri();
  const letterhead = `<header class="lh">
      <div class="lh__mark">${mark ? `<img src="${mark}" alt="">` : ""}</div>
      <div class="lh__id"><strong>Sato Pharma</strong><span dir="ltr">Monthly Closing</span></div>
    </header>
    <div class="lh__rule"></div>`;

  if (!row) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`Rep Card — ${input.areaCode}`)}</title>
<style>${documentCss(false)}${REP_CARD_CSS}</style></head><body>
${letterhead}
<h1 class="rpt__title">Rep Card</h1>
<p class="rpt__empty">No area on this line matches the code ${escapeHtml(input.areaCode)} for ${escapeHtml(orUnknown(input.period, "month"))}.</p>
</body></html>`;
  }

  const text = (index: number) => String(row[index] ?? "").trim();
  const num = (index: number) => (typeof row[index] === "number" ? (row[index] as number) : null);

  const achievement = num(AREA.achievement);
  const sales = num(AREA.sales);
  const target = num(AREA.target);
  const prior = num(AREA.prior);
  const growth = sales !== null && prior !== null && prior !== 0 ? (sales - prior) / prior : null;
  const rank = num(AREA.rank);
  const seats = input.fill.repCard?.targetedAreaCount ?? 0;

  /** Achievement banding — the same three the sheets already use. Nothing invents a scale. */
  const band = (ratio: number | null): "none" | "good" | "warn" | "bad" =>
    ratio === null ? "none" : ratio >= 1 ? "good" : ratio >= 0.8 ? "warn" : "bad";

  // ── The gauge. A ring rather than a bar: it is the one number this page exists to state, and a
  // ring reads as a verdict where a bar reads as a row in a table. Drawn in SVG so it stays crisp at
  // print resolution — a canvas or an image would not.
  const RING = { c: 0, r: 46, stroke: 13 };
  RING.c = 2 * Math.PI * RING.r;
  const shown = achievement === null ? 0 : Math.max(0, Math.min(1, achievement));
  const gauge = achievement === null
    ? `<div class="gauge__none">No target<span>this area is never scored, and never counted as zero</span></div>`
    : `<svg class="gauge__svg" viewBox="0 0 120 120" role="img" aria-label="Achievement">
        <circle cx="60" cy="60" r="${RING.r}" class="gauge__track" stroke-width="${RING.stroke}" fill="none"/>
        <circle cx="60" cy="60" r="${RING.r}" class="gauge__arc gauge__arc--${band(achievement)}" stroke-width="${RING.stroke}" fill="none"
          stroke-linecap="butt" stroke-dasharray="${(shown * RING.c).toFixed(2)} ${RING.c.toFixed(2)}"
          transform="rotate(-90 60 60)"/>
        <text x="60" y="58" class="gauge__pct gauge__pct--${band(achievement)}">${PERCENT.format(achievement * 100)}%</text>
        <text x="60" y="74" class="gauge__cap">of target</text>
      </svg>`;

  const stat = (label: string, value: string, note = "", tone: "none" | "good" | "warn" | "bad" = "none") =>
    `<div class="stat stat--${tone}"><span class="stat__k">${escapeHtml(label)}</span><span class="stat__v">${escapeHtml(value)}</span>${note ? `<span class="stat__n">${escapeHtml(note)}</span>` : ""}</div>`;

  // ── This month against last, drawn to scale rather than stated as a percentage. Both bars share
  // one denominator — the larger of the two — so their lengths are honestly comparable.
  const peak = Math.max(sales ?? 0, prior ?? 0, 1);
  const compare = sales === null && prior === null
    ? ""
    : `<section class="block">
        <h2 class="block__h">Against last month</h2>
        <div class="cmp">
          <div class="cmp__row"><span class="cmp__k">This month</span><span class="cmp__bar"><span class="cmp__fill cmp__fill--now" style="width:${Math.max(1, Math.round(((sales ?? 0) / peak) * 100))}%"></span></span><span class="cmp__v">${escapeHtml(formatCell(sales, "Sales value"))}</span></div>
          <div class="cmp__row"><span class="cmp__k">Last month</span><span class="cmp__bar"><span class="cmp__fill cmp__fill--was" style="width:${Math.max(1, Math.round(((prior ?? 0) / peak) * 100))}%"></span></span><span class="cmp__v">${escapeHtml(formatCell(prior, "Sales value"))}</span></div>
        </div>
        ${growth === null ? "" : `<p class="cmp__note cmp__note--${growth >= 0 ? "good" : "bad"}">${growth >= 0 ? "▲" : "▼"} ${escapeHtml(PERCENT.format(Math.abs(growth) * 100))}% ${growth >= 0 ? "above" : "below"} last month</p>`}
      </section>`;

  const products = input.fill.data.salesData
    .filter((line) => String(line[SALES.code] ?? "").trim().toUpperCase() === text(AREA.code).toUpperCase())
    .sort((a, b) => (typeof b[SALES.sales] === "number" ? (b[SALES.sales] as number) : 0) - (typeof a[SALES.sales] === "number" ? (a[SALES.sales] as number) : 0));

  const productBlock = products.length === 0
    ? `<p class="rpt__empty">This area recorded no sales in ${escapeHtml(orUnknown(input.period, "month"))}.</p>`
    : products.map((line) => {
        const value = typeof line[SALES.sales] === "number" ? (line[SALES.sales] as number) : null;
        const goal = typeof line[SALES.target] === "number" ? (line[SALES.target] as number) : null;
        const hit = goal && goal > 0 && value !== null ? value / goal : null;
        const width = hit === null ? 0 : Math.max(1, Math.min(100, Math.round(hit * 100)));
        return `<article class="prod">
          <div class="prod__top">
            <span class="prod__name">${escapeHtml(String(line[SALES.product] ?? "—"))}</span>
            <span class="prod__ach prod__ach--${band(hit)}">${escapeHtml(hit === null ? "no target" : `${PERCENT.format(hit * 100)}%`)}</span>
          </div>
          <div class="prod__track"><span class="prod__fill prod__fill--${band(hit)}" style="width:${width}%"></span><span class="prod__goal"></span></div>
          <div class="prod__facts">
            <span><b>${escapeHtml(formatCell(line[SALES.sales] ?? null, "Sales value"))}</b> of ${escapeHtml(formatCell(line[SALES.target] ?? null, "Target value"))} EGP</span>
            <span>${escapeHtml(formatCell(line[SALES.units] ?? null, "Units"))} of ${escapeHtml(formatCell(line[SALES.targetUnits] ?? null, "Target units"))} units</span>
            <span class="prod__status prod__status--${band(hit)}">${escapeHtml(String(line[SALES.status] ?? "—"))}</span>
          </div>
        </article>`;
      }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`${text(AREA.rep) || "Rep Card"} — ${text(AREA.area)}`)}</title>
<style>${documentCss(false)}${REP_CARD_CSS}</style></head><body>
${letterhead}

<section class="hero">
  <div class="hero__who">
    <p class="hero__eyebrow">Rep Card &nbsp;·&nbsp; ${escapeHtml(orUnknown(input.line, "line"))} &nbsp;·&nbsp; ${escapeHtml(orUnknown(input.period, "month"))}</p>
    <h1 class="hero__name">${escapeHtml(text(AREA.rep) || "Vacant seat")}</h1>
    <p class="hero__where">${escapeHtml([text(AREA.area), text(AREA.region)].filter(Boolean).join("  ·  "))}</p>
  </div>
  ${rank === null ? "" : `<div class="hero__rank">
    <span class="hero__rankk">Rank</span>
    <span class="hero__rankv">${rank === 1 ? "★" : ""}${INTEGER.format(rank)}</span>
    <span class="hero__rankn">of ${INTEGER.format(seats)} targeted areas</span>
  </div>`}
</section>

<p class="meta">District manager <strong>${escapeHtml(text(AREA.manager) || "—")}</strong>
  &nbsp;·&nbsp; Area code <strong>${escapeHtml(text(AREA.code))}</strong></p>

<section class="verdict">
  <div class="gauge">${gauge}</div>
  <div class="stats">
    ${stat("Sales value", formatCell(sales, "Sales value"), "EGP, this month")}
    ${stat("Target value", formatCell(target, "Target value"), "for this area")}
    ${stat("Shortfall", sales !== null && target !== null && target > sales ? formatCell(target - sales, "Sales value") : "none", sales !== null && target !== null && target > sales ? "still to find" : "target met", sales !== null && target !== null && target > sales ? band(achievement) : "good")}
    ${stat("Against last month", growth === null ? "—" : `${growth >= 0 ? "+" : "−"}${PERCENT.format(Math.abs(growth) * 100)}%`, prior === null ? "no prior figure" : `was ${INTEGER.format(prior)}`, growth === null ? "none" : growth >= 0 ? "good" : "bad")}
  </div>
</section>

${compare}

<section class="block">
  <h2 class="block__h">Every product, this area</h2>
  ${productBlock}
</section>

<footer class="foot">
  <span>Achievement is targeted sales over target value. An area with no target is never scored, and never counted as zero.</span>
  <span>Units are never summed across products — each product is judged against its own target.</span>
</footer>
</body></html>`;
}

/**
 * The card's own layout.
 *
 * Built to fill an A4 page rather than to sit at the top of one. The palette is the house one,
 * sampled from the mark, plus the three achievement bands the sheets already use.
 */
const REP_CARD_CSS = `
  /* ── hero ───────────────────────────────────────────────────────────────── */
  .hero { display: flex; align-items: stretch; justify-content: space-between; gap: 6mm; margin: 5mm 0 0; }
  .hero__eyebrow { margin: 0 0 1.5mm; color: var(--phx-doc-blue); font-size: 7.4pt; font-weight: 800; text-transform: uppercase; letter-spacing: .14em; }
  .hero__name { margin: 0; color: var(--phx-doc-deep); font-size: 27pt; font-weight: 800; line-height: 1.02; letter-spacing: -0.015em; }
  .hero__where { margin: 1.6mm 0 0; color: var(--phx-doc-body); font-size: 11pt; font-weight: 600; }
  .hero__rank { min-width: 34mm; padding: 3mm 4mm; background: var(--phx-doc-deep); color: #fff; text-align: center; display: flex; flex-direction: column; justify-content: center; }
  .hero__rankk { font-size: 6.8pt; font-weight: 800; text-transform: uppercase; letter-spacing: .16em; opacity: .8; }
  .hero__rankv { font-size: 30pt; font-weight: 800; line-height: 1; margin: .6mm 0; }
  .hero__rankn { font-size: 6.6pt; font-weight: 600; opacity: .85; }

  .meta { margin: 3mm 0 0; padding: 2mm 0; border-top: .5pt solid var(--phx-doc-hair); border-bottom: .5pt solid var(--phx-doc-hair); color: var(--phx-doc-muted); font-size: 8.4pt; font-weight: 600; }
  .meta strong { color: var(--phx-doc-deep); font-weight: 800; }

  /* ── the verdict: ring + supporting figures ─────────────────────────────── */
  .verdict { display: flex; align-items: center; gap: 7mm; margin: 6mm 0 0; }
  .gauge { flex: 0 0 44mm; display: flex; justify-content: center; }
  .gauge__svg { width: 44mm; height: 44mm; }
  .gauge__track { stroke: #E4ECF3; }
  .gauge__arc--good { stroke: #1E7B45; }
  .gauge__arc--warn { stroke: #E0A128; }
  .gauge__arc--bad  { stroke: #C7433D; }
  .gauge__arc--none { stroke: #B9C7D4; }
  .gauge__pct { font-size: 21px; font-weight: 800; text-anchor: middle; fill: var(--phx-doc-deep); }
  .gauge__pct--good { fill: #1E7B45; } .gauge__pct--warn { fill: #B4771A; } .gauge__pct--bad { fill: #B3312C; }
  .gauge__cap { font-size: 8px; font-weight: 700; text-anchor: middle; fill: #5A6B7C; text-transform: uppercase; letter-spacing: .1em; }
  .gauge__none { width: 44mm; padding: 6mm 3mm; border: .8mm solid #E4ECF3; text-align: center; color: var(--phx-doc-muted); font-size: 10pt; font-weight: 800; }
  .gauge__none span { display: block; margin-top: 1.5mm; font-size: 6.6pt; font-weight: 600; }

  .stats { flex: 1 1 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 2.4mm; }
  .stat { padding: 2.6mm 3mm; background: var(--phx-doc-tint); border-inline-start: 1.2mm solid var(--phx-doc-blue); }
  .stat__k { display: block; color: var(--phx-doc-muted); font-size: 6.8pt; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
  .stat__v { display: block; color: var(--phx-doc-deep); font-size: 16pt; font-weight: 800; line-height: 1.12; }
  .stat__n { display: block; color: var(--phx-doc-muted); font-size: 6.6pt; font-weight: 600; }
  .stat--good { background: #EAF6EE; border-inline-start-color: #1E7B45; } .stat--good .stat__v { color: #1E7B45; }
  .stat--warn { background: #FDF3E3; border-inline-start-color: #E0A128; } .stat--warn .stat__v { color: #B4771A; }
  .stat--bad  { background: #FCEDED; border-inline-start-color: #C7433D; } .stat--bad  .stat__v { color: #B3312C; }

  /* ── blocks ─────────────────────────────────────────────────────────────── */
  .block { margin: 7mm 0 0; }
  .block__h { margin: 0 0 2.5mm; padding-bottom: 1.2mm; border-bottom: .8mm solid var(--phx-doc-blue); color: var(--phx-doc-deep); font-size: 11pt; font-weight: 800; letter-spacing: -0.01em; }

  .cmp__row { display: flex; align-items: center; gap: 3mm; margin: 2mm 0; }
  .cmp__k { flex: 0 0 22mm; color: var(--phx-doc-muted); font-size: 7.6pt; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
  .cmp__bar { flex: 1 1 auto; height: 5mm; background: #EEF3F8; }
  .cmp__fill { display: block; height: 100%; }
  .cmp__fill--now { background: var(--phx-doc-blue); }
  .cmp__fill--was { background: #B9C7D4; }
  .cmp__v { flex: 0 0 26mm; text-align: end; color: var(--phx-doc-deep); font-size: 9.5pt; font-weight: 800; font-variant-numeric: tabular-nums; }
  .cmp__note { margin: 1.5mm 0 0 25mm; font-size: 8.4pt; font-weight: 800; }
  .cmp__note--good { color: #1E7B45; } .cmp__note--bad { color: #B3312C; }

  /* ── products ───────────────────────────────────────────────────────────── */
  .prod { padding: 3mm 0; border-bottom: .5pt solid var(--phx-doc-hair); break-inside: avoid; }
  .prod:last-child { border-bottom: 0; }
  .prod__top { display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; }
  .prod__name { color: var(--phx-doc-deep); font-size: 11.5pt; font-weight: 800; }
  .prod__ach { font-size: 12pt; font-weight: 800; font-variant-numeric: tabular-nums; }
  .prod__ach--good { color: #1E7B45; } .prod__ach--warn { color: #B4771A; } .prod__ach--bad { color: #B3312C; } .prod__ach--none { color: #7C8B99; }
  .prod__track { position: relative; height: 3.4mm; background: #EEF3F8; margin: 1.8mm 0; }
  .prod__fill { display: block; height: 100%; }
  .prod__fill--good { background: #1E7B45; } .prod__fill--warn { background: #E0A128; } .prod__fill--bad { background: #C7433D; } .prod__fill--none { background: #B9C7D4; }
  .prod__goal { position: absolute; top: -1mm; bottom: -1mm; inset-inline-start: 100%; width: .5mm; background: var(--phx-doc-deep); }
  .prod__facts { display: flex; gap: 6mm; color: var(--phx-doc-muted); font-size: 8pt; font-weight: 600; }
  .prod__facts b { color: var(--phx-doc-deep); font-weight: 800; }
  .prod__status { margin-inline-start: auto; padding: .4mm 2mm; color: #fff; font-size: 7.2pt; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
  .prod__status--good { background: #1E7B45; } .prod__status--warn { background: #B4771A; } .prod__status--bad { background: #B3312C; } .prod__status--none { background: #7C8B99; }

  .foot { margin: 8mm 0 0; padding-top: 2.5mm; border-top: .5pt solid var(--phx-doc-hair); display: flex; flex-direction: column; gap: .8mm; color: var(--phx-doc-muted); font-size: 6.8pt; }
`;

/** Render one rep's card. Portrait always — a card is a page, not a spread. */
export async function renderRepCardPdf(input: RepCardPdfInput): Promise<Buffer> {
  const html = buildRepCardHtml(input);
  return withChromiumPage(async (page) => {
    await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      displayHeaderFooter: true,
      footerTemplate: footerTemplate(input.line, input.period),
      format: "A4",
      headerTemplate: "<span></span>",
      landscape: false,
      preferCSSPageSize: true,
      printBackground: true,
    });
    return Buffer.from(pdf);
  });
}
