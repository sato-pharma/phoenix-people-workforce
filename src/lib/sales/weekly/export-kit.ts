import type { Workbook, Worksheet } from "@node-projects/excelforge";

import { HOUSE_DOCUMENT_STANDARD } from "@/lib/export/house-xlsx-palette";
import { WEEKLY_TRACKED_LINES_LABEL } from "@/lib/sales/weekly/tracked-lines";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";

// ──────────────────────────────────────────────────────────────────────────────
// Weekly Sales BI workbook — shared kit (ExcelForge engine).
//
// Brand palette, number formats, the hidden `Data` Excel-Table column map, style
// helpers, the branded band header, formula builders (SUMIFS/COUNTIFS/share), and
// the layout helpers (outline grouping, section titles, nav links, print setup)
// that every sheet builder in `export-workbook.ts` reuses.
//
// HARDENING (why this kit exists): this file's xlsx has triggered Excel "repair"
// twice. Three rules are enforced here so a builder cannot reintroduce them:
//  1. `cleanText`/`esc` strip XML-illegal control chars + normalise NBSP — a stray
//     control byte in a product/region name => malformed XML => guaranteed repair.
//  2. SUMIFS criteria match CODE columns (controlled ids), never display names.
//  3. Every conditional-format rule must get a UNIQUE priority per sheet
//     (ExcelForge defaults them all to 1 → duplicate priorities → repair) — use
//     `makeCfPriority()` per sheet.
// ──────────────────────────────────────────────────────────────────────────────

// ── the house document identity — SATO-DIS-2026-01 v1.0 ─────────────────────────
//
// Every colour is the COMPANY's, measured from the Sato Pharma mark, never this app's. The ink rule
// holds: colour is carried by LINES and TYPE, never by filled area, and the one permitted fill is
// the 6% zebra row.
//
// THE NAMES CHANGED, DELIBERATELY. This kit used to export `ORANGE`, `SLATE_900` and `ZEBRA` (a
// warm orange band). Leaving those names pointed at blues would be the same mistake as naming a bag
// of pharmacies `contacts`: the next session reads the name, believes it, and reprints the old look
// from memory. So the names say what the values are.
//
// WHAT THE INK RULE DOES **NOT** REACH HERE: the conditional formats in `export-workbook.ts`. A
// colour scale IS the analysis on a matrix sheet — there is no type-only form of a heatmap, and
// removing it removes the reading rather than the decoration. Those are re-pointed into this palette
// where they express MAGNITUDE (white to light to deep, a proper sequential ramp) and keep a real
// signal colour where they express a VERDICT. Chrome follows the ink rule; data-driven emphasis is
// the data.
export const DEEP = "FF0A527D";
export const BLUE = "FF0A6BA6";
export const LIGHT = "FF1482C2";
export const TINT = "FFF2F6FA"; // Brand Blue at 6% — the zebra, and the only fill in the chrome
export const HAIR = "FFB9C7D4"; // hairline grey for cell grids
export const MUTED = "FF5A6B7C"; // secondary type: sub-labels, provenance, units
export const BODY = "FF1A1A1A";
export const WHITE = "FFFFFFFF";
// Verdict colours. TYPE and data-driven emphasis only, never chrome — see the note above. The red is
// the standard's own sanctioned non-logo colour rather than a second red invented here.
export const GOOD = "FF0F766E";
export const WARN = "FF9A5B08";
export const BAD = "FFB3261E";

// ── number formats ──────────────────────────────────────────────────────────────
export const F_VALUE = "#,##0";
export const F_UNITS = "#,##0";
export const F_PCT = "0.0%";
export const F_Z = "0.00"; // z-score
export const F_WK = "0.0"; // weeks-of-cover

// ── size guardrails (each builder warns + writes a "truncated" note when hit) ─────
export const MAX_MATRIX_PRODUCTS = 120;
export const MAX_TRAJ_WEEKS = 13;
export const MAX_COVERAGE_COMBOS = 6000;
export const MAX_RP_PAIRS = 1500;

// ── hidden Data sheet column map (1-based index → letter) ────────────────────────
export const DATA = {
  Distributor: 1, DistCode: 2, Product: 3, ProductCode: 4, Line: 5,
  Region: 6, RegionCode: 7, Branch: 8, BranchCode: 9, Month: 10,
  Week: 11, WeekStart: 12, Value: 13, Units: 14, Stock: 15,
} as const;
export const DATA_HEADERS = Object.keys(DATA);
export const DATA_NCOLS = DATA_HEADERS.length;

export function colLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
  return s;
}
export const L = (key: keyof typeof DATA) => colLetter(DATA[key]);

// ── sanitisers (hardening rule #1) ──────────────────────────────────────────────
// Regexes are built from char codes (NOT escape literals) so no control byte is
// ever written into THIS source file — the same corruption we strip from the data.
const CTRL_RE = (() => {
  let chars = "";
  for (let i = 0; i <= 0x1f; i += 1) {
    if (i === 0x09 || i === 0x0a || i === 0x0d) continue; // keep tab / LF / CR
    chars += String.fromCharCode(i);
  }
  return new RegExp(`[${chars}]`, "g");
})();
const NBSP_RE = new RegExp(String.fromCharCode(0xa0), "g");

/** Strip XML-illegal control chars (keep tab/newline/CR) + normalise NBSP. Use for
 *  EVERY dataset-origin string written to a cell (shared strings) or a formula. */
export const cleanText = (s: unknown) => String(s ?? "").replace(CTRL_RE, "").replace(NBSP_RE, " ");
/** As cleanText, plus doubles `"` for safe embedding inside an Excel `"…"` literal. */
export const esc = (s: unknown) => cleanText(s).replace(/"/g, '""');
/** As cleanText, plus doubles `&` for an Excel header/footer command string. */
export const escAmp = (s: unknown) => cleanText(s).replace(/&/g, "&&");

// ── formula builders (hardening rule #2: criteria target CODE columns) ───────────
export const dataRange = (key: keyof typeof DATA, last: number) =>
  `Data!$${L(key)}$2:$${L(key)}$${last}`;

export type Crit = [keyof typeof DATA, string];
/** SUMIFS over a Data measure column with N equality criteria (literals esc()'d). */
export function sumifs1(sumKey: keyof typeof DATA, last: number, crit: Crit[]): string {
  const tail = crit.map(([k, v]) => `,${dataRange(k, last)},"${esc(v)}"`).join("");
  return `SUMIFS(${dataRange(sumKey, last)}${tail})`;
}
/** COUNTIFS over Data columns with N equality criteria. */
export function countifs1(last: number, crit: Crit[]): string {
  return `COUNTIFS(${crit.map(([k, v]) => `${dataRange(k, last)},"${esc(v)}"`).join(",")})`;
}
export const div0 = (num: string, den: string) => `IFERROR(${num}/${den},0)`;
export const sumRange = (range: string) => `SUM(${range})`;

// ── conditional-format priority (hardening rule #3) ──────────────────────────────
/** Returns a per-sheet counter; call it for every addConditionalFormat so each rule
 *  gets a unique priority (1 = most important). */
export function makeCfPriority() {
  let p = 0;
  return () => { p += 1; return p; };
}

// ── style helpers ────────────────────────────────────────────────────────────────
export type CS = Parameters<Worksheet["setStyle"]>[2];
export const fill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: argb });
export const border = () => { const s = { style: "thin" as const, color: HAIR }; return { top: s, bottom: s, left: s, right: s }; };

/** The rule a header sits under, and a total sits between. A line, never a band. */
const RULE_BLUE = { style: "medium" as const, color: BLUE };

export const titleStyle: CS = { font: { bold: true, size: 16, color: DEEP, name: "Aptos Display" }, alignment: { vertical: "center", indent: 1 } };
export const subtitleStyle: CS = { font: { size: 9, color: MUTED, name: "Aptos" }, alignment: { vertical: "center", indent: 1 } };
export const headerStyle: CS = { font: { bold: true, size: 10, color: DEEP, name: "Aptos" }, alignment: { vertical: "bottom", horizontal: "left", indent: 1 }, border: { bottom: RULE_BLUE, top: { style: "thin" as const, color: HAIR } } };
export const headerRightStyle: CS = { ...headerStyle, alignment: { vertical: "bottom", horizontal: "right", indent: 1 } };
export const totalStyle: CS = { font: { bold: true, size: 10.5, color: DEEP, name: "Aptos" }, border: { bottom: RULE_BLUE, top: RULE_BLUE }, alignment: { vertical: "center", indent: 1 } };
export const totalNumStyle = (fmt: string): CS => ({ font: { bold: true, size: 10.5, color: DEEP, name: "Aptos" }, border: { bottom: RULE_BLUE, top: RULE_BLUE }, alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt } });

export function textCell(bold = false, zebra = false): CS {
  return { font: { color: BODY, size: 10, bold, name: "Aptos" }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(TINT) } : {}) };
}
export function numCell(fmt: string, zebra = false): CS {
  return { font: { color: BODY, size: 10, name: "Aptos" }, alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt }, border: border(), ...(zebra ? { fill: fill(TINT) } : {}) };
}
/** The REPT() bar (in-cell sparkline emulation). It reads MAGNITUDE, so it takes the brand blue
 *  rather than a verdict colour — a long bar is not a good bar. */
export function barCell(zebra = false): CS {
  return { font: { name: "Aptos", size: 10, color: LIGHT, bold: true }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(TINT) } : {}) };
}

/**
 * The house masthead: row 1 the title in deep type, row 2 the subtitle in muted type, row 3 a Brand
 * Blue rule the full width.
 *
 * THREE ROWS STILL, deliberately — every sheet builder in `export-workbook.ts` starts its content at
 * row 4 and freezes there, so the footprint is what must not move. What changed is the ink: two
 * full-width slate bands and a thick orange rule became type on white over one 3px rule, which is
 * the single filled shape the ink rule allows outside the zebra.
 *
 * NO WORDMARK, and that is a limit rather than a choice: ExcelForge has no image API at all, so this
 * workbook cannot carry the mark the way the ExcelJS exports do. The rule and the type carry the
 * identity here.
 */
export function bandHeader(sheet: Worksheet, cols: number, title: string, subtitle: string) {
  sheet.merge(1, 1, 1, cols); sheet.setValue(1, 1, cleanText(title)); sheet.setStyle(1, 1, titleStyle); sheet.setRowHeight(1, 26);
  sheet.merge(2, 1, 2, cols); sheet.setValue(2, 1, cleanText(subtitle)); sheet.setStyle(2, 1, subtitleStyle); sheet.setRowHeight(2, 15);
  for (let c = 1; c <= cols; c += 1) sheet.setStyle(3, c, { fill: fill(BLUE) });
  sheet.setRowHeight(3, 3);
}

/** A section divider: deep type over a Brand Blue rule, no band. */
export function sectionTitle(sheet: Worksheet, row: number, cols: number, label: string): number {
  sheet.merge(row, 1, row, cols); sheet.setValue(row, 1, cleanText(label));
  sheet.setStyle(row, 1, { font: { bold: true, size: 10.5, color: DEEP, name: "Aptos" }, alignment: { vertical: "bottom", indent: 1 }, border: { bottom: { style: "medium" as const, color: BLUE } } });
  for (let c = 2; c <= cols; c += 1) sheet.setStyle(row, c, { border: { bottom: { style: "medium" as const, color: BLUE } } });
  sheet.setRowHeight(row, 20);
  return row + 1;
}

/** Right-aligned "↑ Dashboard" link via the HYPERLINK() worksheet function (the only
 *  link form ExcelForge serialises — `cell.hyperlink` is silently dropped). */
export function addNavLink(sheet: Worksheet, row: number, col: number) {
  try {
    sheet.setFormula(row, col, `HYPERLINK("#Dashboard!A1","↑ Dashboard")`);
  } catch {
    sheet.setValue(row, col, "↑ Dashboard (first tab)");
  }
  sheet.setStyle(row, col, { font: { bold: true, size: 9, color: BLUE, name: "Aptos", underline: "single" }, alignment: { vertical: "center", horizontal: "right", indent: 1 } });
}

// ── outline grouping (read-merge: setRow REPLACES the row def, setRowHeight merges) ─
type RowDefArg = Parameters<Worksheet["setRow"]>[1];
/** Set a row's outline level without losing an existing height/style (read-merge). */
export function groupRow(sheet: Worksheet, row: number, level: number, collapsed = false) {
  try {
    const ex = (sheet.getRow?.(row) as RowDefArg) ?? ({} as RowDefArg);
    sheet.setRow(row, { ...(ex as object), outlineLevel: level, ...(collapsed ? { collapsed: true } : {}) } as RowDefArg);
  } catch { /* grouping is cosmetic — never fail the export over it */ }
}
/** Hide a contiguous band of detail rows at an outline level (ExcelForge does not
 *  auto-hide collapsed groups, so set hidden:true explicitly). */
export function collapseBand(sheet: Worksheet, firstDetail: number, lastDetail: number, level: number) {
  for (let r = firstDetail; r <= lastDetail; r += 1) {
    try {
      const ex = (sheet.getRow?.(r) as RowDefArg) ?? ({} as RowDefArg);
      sheet.setRow(r, { ...(ex as object), outlineLevel: level, hidden: true } as RowDefArg);
    } catch { /* ignore */ }
  }
}

// ── print / page setup (landscape, fit-to-width, branded header/footer) ──────────
export function applyPrintSetup(sheet: Worksheet, title: string, generatedAt: string, lastCol: number, lastRow: number) {
  try {
    sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    sheet.pageMargins = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
    sheet.headerFooter = {
      // The COMPANY's identity on the printed page, never the app's — a Sato Pharma document does
      // not introduce itself as the software that produced it.
      oddHeader: `&L&"Aptos,Bold"&10 ${escAmp(title)}&R&8 ${escAmp(HOUSE_DOCUMENT_STANDARD)}`,
      oddFooter: `&L&8 Confidential&C&8 Page &P of &N&R&8 ${escAmp(generatedAt)}`,
    };
    sheet.printOptions = { gridLines: false, centerHorizontal: true };
    sheet.printArea = `A1:${colLetter(Math.max(1, lastCol))}${Math.max(1, lastRow)}`;
  } catch { /* print setup is polish — never fail the export over it */ }
}

// ── filter-label subtitle (shared by Dashboard + every sheet band) ───────────────
export function labelFilters(f: WeeklyDashboard["appliedFilters"]): string {
  const parts: string[] = [];
  if (f.cycleMonths?.length) parts.push(`Months: ${f.cycleMonths.map((m) => m.slice(0, 7)).join(", ")}`);
  if (f.weekNumbers?.length) parts.push(`Weeks: ${f.weekNumbers.map((w) => `W${w}`).join(", ")}`);
  if (f.distributorCodes?.length) parts.push(`Distributors: ${f.distributorCodes.join(", ")}`);
  if (f.regionCodes?.length) parts.push(`Regions: ${f.regionCodes.join(", ")}`);
  if (f.productCodes?.length) parts.push(`Products: ${f.productCodes.join(", ")}`);
  if (parts.length === 0) parts.push("All distributors · all weeks");
  // The LINE scope is stated unconditionally, because "no line filter" is not "every line": with no
  // line named the workbook covers the TRACKED lines only. The owner's rule is that an export matches
  // the screen, and the screen now says the same thing — a sheet must never imply it holds everything
  // while Head Office (78% of the weekly tables) sits outside it.
  parts.push(f.lineCodes?.length ? `Lines: ${f.lineCodes.join(", ")}` : `Lines: ${WEEKLY_TRACKED_LINES_LABEL} (tracked weekly)`);
  return parts.join("   ·   ");
}

// Re-export Workbook type for builders that need it without a second import.
export type { Workbook, Worksheet };
