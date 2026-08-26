import type { Workbook, Worksheet } from "@node-projects/excelforge";

import { systemIdentity } from "@/config/system-settings";
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

// ── premium palette ─────────────────────────────────────────────────────────────
export const ORANGE = "FFF97316";
export const ORANGE_DEEP = "FFEA580C";
export const BLUE = "FF2563EB";
export const SLATE_900 = "FF0F172A";
export const SLATE_800 = "FF1E293B";
export const WHITE = "FFFFFFFF";
export const INK = "FF1E293B";
export const ZEBRA = "FFFDF3EA"; // warm light-orange band
export const GRIDC = "FFF6C9A4"; // light-orange gridlines (admin-shell language)
export const GREEN = "FF16A34A";
export const AMBER = "FFF59E0B";
export const RED = "FFDC2626";

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
export const border = () => { const s = { style: "thin" as const, color: GRIDC }; return { top: s, bottom: s, left: s, right: s }; };

export const titleStyle: CS = { font: { bold: true, size: 18, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } };
export const subtitleStyle: CS = { font: { size: 10, color: ORANGE, name: "Calibri", bold: true }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } };
export const headerStyle: CS = { font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", horizontal: "left", indent: 1 }, border: border() };
export const headerRightStyle: CS = { ...headerStyle, alignment: { vertical: "center", horizontal: "right", indent: 1 } };
export const totalStyle: CS = { font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_800), border: border(), alignment: { vertical: "center", indent: 1 } };
export const totalNumStyle = (fmt: string): CS => ({ font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_800), border: border(), alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt } });

export function textCell(bold = false, zebra = false): CS {
  return { font: { color: INK, size: 10.5, bold, name: "Calibri" }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}
export function numCell(fmt: string, zebra = false): CS {
  return { font: { color: INK, size: 10.5, name: "Calibri" }, alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}
/** Orange REPT() bar style (in-cell sparkline emulation). */
export function barCell(zebra = false): CS {
  return { font: { name: "Calibri", size: 10.5, color: ORANGE, bold: true }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}

/** Slate-900 brand band: row1 bold title, row2 orange subtitle, row3 thick orange rule. */
export function bandHeader(sheet: Worksheet, cols: number, title: string, subtitle: string) {
  sheet.merge(1, 1, 1, cols); sheet.setValue(1, 1, cleanText(title)); sheet.setStyle(1, 1, titleStyle); sheet.setRowHeight(1, 30);
  for (let c = 1; c <= cols; c += 1) if (c > 1) sheet.setStyle(1, c, { fill: fill(SLATE_900) });
  sheet.merge(2, 1, 2, cols); sheet.setValue(2, 1, cleanText(subtitle)); sheet.setStyle(2, 1, subtitleStyle); sheet.setRowHeight(2, 16);
  for (let c = 1; c <= cols; c += 1) if (c > 1) sheet.setStyle(2, c, { fill: fill(SLATE_900) });
  for (let c = 1; c <= cols; c += 1) sheet.setStyle(3, c, { fill: fill(ORANGE) });
  sheet.setRowHeight(3, 4);
}

/** Slate-800 section divider row (used to label a sub-table within a sheet). */
export function sectionTitle(sheet: Worksheet, row: number, cols: number, label: string): number {
  sheet.merge(row, 1, row, cols); sheet.setValue(row, 1, cleanText(label));
  sheet.setStyle(row, 1, { font: { bold: true, size: 11, color: ORANGE, name: "Calibri" }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
  for (let c = 2; c <= cols; c += 1) sheet.setStyle(row, c, { fill: fill(SLATE_800) });
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
  sheet.setStyle(row, col, { font: { bold: true, size: 9, color: ORANGE, name: "Calibri", underline: "single" }, fill: fill(SLATE_900), alignment: { vertical: "center", horizontal: "right", indent: 1 } });
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
      oddHeader: `&L&"Calibri,Bold"&10 ${escAmp(systemIdentity.appName)} — ${escAmp(title)}&R&8 ${escAmp(generatedAt)}`,
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
