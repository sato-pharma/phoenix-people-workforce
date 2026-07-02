import { Workbook, type Worksheet } from "@node-projects/excelforge";

import { systemIdentity } from "@/config/system-settings";
import { computeOutliers } from "@/lib/sales/sos-analytics";
import type {
  SosContributionRow,
  SosDashboardData,
  SosDetailLeafRow,
  SosMomComparison,
  SosMoverRow,
  SosNewLostRow,
} from "@/lib/sales/sos-dashboard";

// ──────────────────────────────────────────────────────────────────────────────
// Flagship admin Source-of-Sales BI workbook (CEO / Super Admin only — gated by the
// export route) — ExcelForge engine, feature parity with the weekly BI workbook:
// native embedded charts, a native Excel Table (`tblSos`) on the hidden Data sheet,
// icon-set traffic-lights + cellIs hard-zero / hi-lo conditional formatting, REPT()
// in-cell bar sparklines and collapsible outline drill-downs.
//
// The input is the output of getSosDashboard(..., { includeMomComparison,
// includeDetailRows }) — already scoped, confidential-stripped and valued. This
// module adds ZERO calculation semantics: every reconstructable number is a live
// SUMIFS / SUM / share formula over the hidden Data sheet (criteria always target
// CODE columns), so editing the data recalculates the report; numbers that cannot
// be rebuilt from the leaf grain (customer counts, brick reach, MoM prior values,
// pareto cumulative shares) are written as plain values from the payload.
//
// Excel-"repair" hardening (same rules as the weekly module, re-implemented locally
// so the two modules stay independent):
//  1. cleanText/esc strip XML-illegal control chars + normalise NBSP on EVERY
//     dataset-origin string (regexes built from char codes so no control byte ever
//     lands in this source file).
//  2. Every conditional-format rule gets a UNIQUE priority per sheet via
//     makeCfPriority() (ExcelForge defaults them all to 1 → guaranteed repair).
//  3. Sheet names are ASCII only; navigation uses HYPERLINK() formulas (the only
//     link form ExcelForge serialises); every exotic call (chart / CF / table /
//     outline / print) is wrapped so a failure degrades instead of corrupting.
// ──────────────────────────────────────────────────────────────────────────────

// ── premium palette ─────────────────────────────────────────────────────────────
const ORANGE = "FFF97316";
const ORANGE_DEEP = "FFEA580C";
const BLUE = "FF2563EB";
const SLATE_900 = "FF0F172A";
const SLATE_800 = "FF1E293B";
const WHITE = "FFFFFFFF";
const INK = "FF1E293B";
const MUTED = "FF64748B";
const ZEBRA = "FFFDF3EA"; // warm light-orange band
const GRIDC = "FFF6C9A4"; // light-orange gridlines (admin-shell language)
const GREEN = "FF16A34A";
const AMBER = "FFF59E0B";
const RED = "FFDC2626";

// ── number formats (money is integer EGP everywhere — millions make decimals noise) ─
const F_VALUE = "#,##0";
const F_UNITS = "#,##0";
const F_PCT = "0.0%";
const F_Z = "0.00";

// ── hidden Data sheet column map (1-based index; MUST track DATA_HEADERS order) ──
const DATA = {
  Period: 1, DistCode: 2, Distributor: 3, Line: 4, RegionCode: 5, Region: 6,
  AreaCode: 7, Area: 8, ProductCode: 9, Product: 10, Channel: 11, Units: 12, Value: 13,
} as const;
const DATA_HEADERS = [
  "Period", "Distributor Code", "Distributor", "Line", "Region Code", "Region",
  "Area Code", "Area", "Product Code", "Product", "Channel", "Units", "Value",
];
const DATA_NCOLS = DATA_HEADERS.length;
// Chart helper series live BEYOND the table columns, on the HIDDEN Data sheet — never on the
// Dashboard itself (raw helper numbers must not show next to the charts).
const TREND_LBL_COL = DATA_NCOLS + 2;
const TREND_VAL_COL = DATA_NCOLS + 3;
const BRIDGE_LBL_COL = DATA_NCOLS + 5;
const BRIDGE_VAL_COL = DATA_NCOLS + 6;
const CHMIX_LBL_COL = DATA_NCOLS + 8;
const CHMIX_VAL_COL = DATA_NCOLS + 9;

function colLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
  return s;
}
const L = (key: keyof typeof DATA) => colLetter(DATA[key]);

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
const cleanText = (s: unknown) => String(s ?? "").replace(CTRL_RE, "").replace(NBSP_RE, " ");
/** As cleanText, plus doubles `"` for safe embedding inside an Excel `"…"` literal. */
const esc = (s: unknown) => cleanText(s).replace(/"/g, '""');
/** As cleanText, plus doubles `&` for an Excel header/footer command string. */
const escAmp = (s: unknown) => cleanText(s).replace(/&/g, "&&");

// ── formula builders (hardening rule #2: criteria target CODE columns) ───────────
const dataRange = (key: keyof typeof DATA, last: number) =>
  `Data!$${L(key)}$2:$${L(key)}$${last}`;

type Crit = [keyof typeof DATA, string];
/** SUMIFS over a Data measure column with N equality criteria (literals esc()'d). */
function sumifs1(sumKey: keyof typeof DATA, last: number, crit: Crit[]): string {
  const tail = crit.map(([k, v]) => `,${dataRange(k, last)},"${esc(v)}"`).join("");
  return `SUMIFS(${dataRange(sumKey, last)}${tail})`;
}
const div0 = (num: string, den: string) => `IFERROR(${num}/${den},0)`;

// ── conditional-format priority (hardening rule #3) ──────────────────────────────
/** Returns a per-sheet counter; call it for every addConditionalFormat so each rule
 *  gets a unique priority (1 = most important). */
function makeCfPriority() {
  let p = 0;
  return () => { p += 1; return p; };
}

// ── style helpers ────────────────────────────────────────────────────────────────
type CS = Parameters<Worksheet["setStyle"]>[2];
const fill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: argb });
const border = () => { const s = { style: "thin" as const, color: GRIDC }; return { top: s, bottom: s, left: s, right: s }; };

const titleStyle: CS = { font: { bold: true, size: 18, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } };
const subtitleStyle: CS = { font: { size: 10, color: ORANGE, name: "Calibri", bold: true }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } };
const headerStyle: CS = { font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", horizontal: "left", indent: 1 }, border: border() };
const headerRightStyle: CS = { ...headerStyle, alignment: { vertical: "center", horizontal: "right", indent: 1 } };
const totalStyle: CS = { font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_800), border: border(), alignment: { vertical: "center", indent: 1 } };
const totalNumStyle = (fmt: string): CS => ({ font: { bold: true, size: 11, color: WHITE, name: "Calibri" }, fill: fill(SLATE_800), border: border(), alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt } });

function textCell(bold = false, zebra = false): CS {
  return { font: { color: INK, size: 10.5, bold, name: "Calibri" }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}
function numCell(fmt: string, zebra = false): CS {
  return { font: { color: INK, size: 10.5, name: "Calibri" }, alignment: { vertical: "center", horizontal: "right" }, numberFormat: { formatCode: fmt }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}
/** Orange REPT() bar style (in-cell sparkline emulation). */
function barCell(zebra = false): CS {
  return { font: { name: "Calibri", size: 10.5, color: ORANGE, bold: true }, alignment: { vertical: "center", indent: 1 }, border: border(), ...(zebra ? { fill: fill(ZEBRA) } : {}) };
}

/** Slate-900 brand band: row1 bold title, row2 orange subtitle, row3 thick orange rule. */
function bandHeader(sheet: Worksheet, cols: number, title: string, subtitle: string) {
  sheet.merge(1, 1, 1, cols); sheet.setValue(1, 1, cleanText(title)); sheet.setStyle(1, 1, titleStyle); sheet.setRowHeight(1, 30);
  for (let c = 2; c <= cols; c += 1) sheet.setStyle(1, c, { fill: fill(SLATE_900) });
  sheet.merge(2, 1, 2, cols); sheet.setValue(2, 1, cleanText(subtitle)); sheet.setStyle(2, 1, subtitleStyle); sheet.setRowHeight(2, 16);
  for (let c = 2; c <= cols; c += 1) sheet.setStyle(2, c, { fill: fill(SLATE_900) });
  for (let c = 1; c <= cols; c += 1) sheet.setStyle(3, c, { fill: fill(ORANGE) });
  sheet.setRowHeight(3, 4);
}

/** Slate-800 section divider row (labels a sub-table within a sheet). Returns next row. */
function sectionTitle(sheet: Worksheet, row: number, cols: number, label: string): number {
  sheet.merge(row, 1, row, cols); sheet.setValue(row, 1, cleanText(label));
  sheet.setStyle(row, 1, { font: { bold: true, size: 11, color: ORANGE, name: "Calibri" }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
  for (let c = 2; c <= cols; c += 1) sheet.setStyle(row, c, { fill: fill(SLATE_800) });
  sheet.setRowHeight(row, 20);
  return row + 1;
}

/** "↑ Dashboard" link via the HYPERLINK() worksheet function (the only link form
 *  ExcelForge serialises — `cell.hyperlink` is silently dropped). */
function addNavLink(sheet: Worksheet, row: number, col: number) {
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
function groupRow(sheet: Worksheet, row: number, level: number, collapsed = false) {
  try {
    const ex = (sheet.getRow?.(row) as RowDefArg) ?? ({} as RowDefArg);
    sheet.setRow(row, { ...(ex as object), outlineLevel: level, ...(collapsed ? { collapsed: true } : {}) } as RowDefArg);
  } catch { /* grouping is cosmetic — never fail the export over it */ }
}

// ── print / page setup (landscape, fit-to-width, branded header/footer) ──────────
function applyPrintSetup(sheet: Worksheet, title: string, generatedAt: string, lastCol: number, lastRow: number) {
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

/** Small italic muted note row (empty-state messages, legends, truncation notes). */
function noteRow(sheet: Worksheet, row: number, text: string) {
  sheet.setValue(row, 1, cleanText(text));
  sheet.setStyle(row, 1, { font: { italic: true, size: 10, color: MUTED, name: "Calibri" }, alignment: { vertical: "center", indent: 1 } });
}

// ── JS-side aggregation derived from the leaf grain (layout only; values stay formulas) ──
type ProdAgg = { code: string; name: string; value: number; units: number };
type RegionNode = { code: string; name: string; value: number; units: number; products: ProdAgg[] };

/** Region → product tree, regions ordered by value desc, products by value desc. */
function buildRegionTree(rows: SosDetailLeafRow[]): RegionNode[] {
  const regions = new Map<string, { code: string; name: string; value: number; units: number; products: Map<string, ProdAgg> }>();
  for (const r of rows) {
    const rc = cleanText(r.regionCode);
    let reg = regions.get(rc.toUpperCase());
    if (!reg) { reg = { code: rc, name: cleanText(r.regionName || r.regionCode), value: 0, units: 0, products: new Map() }; regions.set(rc.toUpperCase(), reg); }
    reg.value += r.value; reg.units += r.units;
    const pc = cleanText(r.productCode);
    let p = reg.products.get(pc.toUpperCase());
    if (!p) { p = { code: pc, name: cleanText(r.productName || r.productCode), value: 0, units: 0 }; reg.products.set(pc.toUpperCase(), p); }
    p.value += r.value; p.units += r.units;
  }
  return [...regions.values()]
    .sort((a, b) => b.value - a.value)
    .map((reg) => ({ code: reg.code, name: reg.name, value: reg.value, units: reg.units, products: [...reg.products.values()].sort((a, b) => b.value - a.value) }));
}

// ── shared builder context ────────────────────────────────────────────────────────
type Ctx = {
  wb: Workbook;
  data: SosDashboardData;
  subtitle: string;
  period: string;
  priorPeriod: string | null;
  generatedAt: string;
  /** Last row of the hidden Data table (>= 2 even when empty). */
  last: number;
  /** True when detailRows exist → reconstructable numbers become live formulas. */
  hasLeaf: boolean;
  mom: SosMomComparison | null;
};

/** Live SUMIFS when the leaf grain exists, otherwise the server-computed value. */
function putMetric(ctx: Ctx, sheet: Worksheet, row: number, col: number, formula: string, fallback: number) {
  if (ctx.hasLeaf) sheet.setFormula(row, col, formula);
  else sheet.setValue(row, col, fallback);
}

/** Chart-bindable coordinates of a just-written breakdown table. */
type SheetRanges = { sheetName: string; firstRow: number; lastRow: number; nameCol: number; valueCol: number; count: number };

// ── hidden Data sheet: native Excel Table `tblSos` + trend helper series ─────────
function buildDataSheet(wb: Workbook, rows: SosDetailLeafRow[], trend: SosDashboardData["trend"]): number {
  const sheet = wb.addSheet("Data", { state: "hidden" });
  sheet.writeRow(1, 1, DATA_HEADERS);
  const matrix = rows.map((r) => [
    cleanText(r.period), cleanText(r.distributorCode), cleanText(r.distributorName || r.distributorCode),
    cleanText(r.officialLine), cleanText(r.regionCode), cleanText(r.regionName || r.regionCode),
    cleanText(r.areaCode), cleanText(r.areaName || r.areaCode), cleanText(r.productCode),
    cleanText(r.productName || r.productCode), r.channel, r.units, r.value,
  ]);
  if (matrix.length) sheet.writeArray(2, 1, matrix);
  const lastRow = Math.max(2, 1 + matrix.length);
  try {
    sheet.addTable({
      name: "tblSos", displayName: "tblSos",
      ref: `A1:${colLetter(DATA_NCOLS)}${lastRow}`,
      style: "TableStyleMedium2", showRowStripes: true,
      columns: DATA_HEADERS.map((name) => ({ name, filterButton: true })),
    });
  } catch { /* the table is best-effort — formulas use plain ranges, not structured refs */ }
  // Trend helper columns (beyond the table) feed the Dashboard line chart.
  trend.forEach((t, i) => {
    sheet.setValue(2 + i, TREND_LBL_COL, cleanText(t.period));
    sheet.setValue(2 + i, TREND_VAL_COL, t.value);
  });
  return lastRow;
}

// ── MoM Movers (gainers / decliners / new / lost — plain values from the comparison) ─
function buildMomMovers(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("MoM Movers");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 5;
  bandHeader(sheet, ncols, "Month-over-Month Movers", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  let row = 4;
  let lastUsed = 5;

  if (!ctx.mom) {
    noteRow(sheet, 5, (ctx.data.selectedPeriods?.length ?? 0) > 1
      ? "Multi-month selection — month-over-month comparison applies to single-month views only."
      : "No prior validated period exists yet — month-over-month comparison unavailable.");
  } else {
    const mom = ctx.mom;
    const writeMovers = (title: string, movers: SosMoverRow[]) => {
      row = sectionTitle(sheet, row, ncols, title);
      const headerRow = row;
      ["Name", `Prev (${ctx.priorPeriod ?? "—"})`, `Curr (${ctx.period})`, "Δ value", "Δ %"].forEach((h, i) => {
        sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 0 ? headerStyle : headerRightStyle);
      });
      row += 1;
      if (movers.length === 0) { noteRow(sheet, row, "None."); lastUsed = row; row += 2; return; }
      const first = row;
      movers.forEach((m, i) => {
        const zebra = i % 2 === 1;
        sheet.setValue(row, 1, cleanText(m.label)); sheet.setStyle(row, 1, textCell(false, zebra));
        sheet.setValue(row, 2, m.prevValue); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
        sheet.setValue(row, 3, m.value); sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
        sheet.setValue(row, 4, m.delta); sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
        sheet.setValue(row, 5, m.deltaPct); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
        row += 1;
      });
      const lastRow = row - 1;
      try {
        sheet.addConditionalFormat({ sqref: `C${first}:C${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
        sheet.addConditionalFormat({ sqref: `D${first}:D${lastRow}`, type: "cellIs", operator: "greaterThan", formula: "0", style: { font: { color: GREEN, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
        sheet.addConditionalFormat({ sqref: `D${first}:D${lastRow}`, type: "cellIs", operator: "lessThan", formula: "0", style: { font: { color: RED, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      } catch { /* cosmetic */ }
      lastUsed = lastRow;
      row += 1;
    };
    writeMovers("Top product gainers", mom.movers.products.gainers);
    writeMovers("Top product decliners", mom.movers.products.decliners);
    writeMovers("Top region gainers", mom.movers.regions.gainers);
    writeMovers("Top region decliners", mom.movers.regions.decliners);
    writeMovers("Top distributor gainers", mom.movers.distributors.gainers);
    writeMovers("Top distributor decliners", mom.movers.distributors.decliners);

    const writeNewLost = (title: string, rows: SosNewLostRow[], valueHeader: string) => {
      if (rows.length === 0) return;
      row = sectionTitle(sheet, row, ncols, title);
      const headerRow = row;
      ["Name", valueHeader].forEach((h, i) => { sheet.setValue(headerRow, i + 1, cleanText(h)); sheet.setStyle(headerRow, i + 1, i === 0 ? headerStyle : headerRightStyle); });
      row += 1;
      rows.forEach((r, i) => {
        const zebra = i % 2 === 1;
        sheet.setValue(row, 1, cleanText(r.label)); sheet.setStyle(row, 1, textCell(false, zebra));
        sheet.setValue(row, 2, r.value); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
        row += 1;
      });
      lastUsed = row - 1;
      row += 1;
    };
    writeNewLost(`New products in ${ctx.period}`, mom.newProducts, "Value (EGP)");
    writeNewLost(`Products with no sales in ${ctx.period} (had sales in ${mom.priorPeriod})`, mom.lostProducts, `Value in ${mom.priorPeriod} (EGP)`);
    writeNewLost(`Newly covered areas in ${ctx.period}`, mom.newAreas, "Value (EGP)");
    writeNewLost(`Areas lost in ${ctx.period} (had sales in ${mom.priorPeriod})`, mom.lostAreas, `Value in ${mom.priorPeriod} (EGP)`);
  }
  [34, 20, 18, 16, 11].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(3, 0);
  applyPrintSetup(sheet, "MoM Movers", ctx.generatedAt, ncols, Math.max(5, lastUsed));
}

// ── Trend (6-month value + units; deltas are in-sheet formulas; REPT bar) ─────────
function buildTrend(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("Trend");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 6;
  bandHeader(sheet, ncols, "6-Month Trend", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["Period", "Value (EGP)", "Units", "Δ value", "Δ %", "Bar"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 1 && i !== 5 ? headerRightStyle : headerStyle);
  });
  const points = ctx.data.trend;
  const firstRow = headerRow + 1;
  const lastRow = Math.max(firstRow, firstRow + points.length - 1);
  points.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, cleanText(p.period)); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setValue(row, 2, p.value); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
    sheet.setValue(row, 3, p.units); sheet.setStyle(row, 3, numCell(F_UNITS, zebra));
    if (i > 0) {
      sheet.setFormula(row, 4, `B${row}-B${row - 1}`);
      sheet.setFormula(row, 5, `IFERROR((B${row}-B${row - 1})/B${row - 1},0)`);
    }
    sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
    sheet.setStyle(row, 5, numCell(F_PCT, zebra));
    sheet.setFormula(row, 6, `IFERROR(REPT("|",ROUND(B${row}/MAX($B$${firstRow}:$B$${lastRow})*16,0)),"")`);
    sheet.setStyle(row, 6, barCell(zebra));
  });
  if (points.length === 0) noteRow(sheet, firstRow, "No validated periods available.");
  if (points.length > 0) {
    try {
      sheet.addConditionalFormat({ sqref: `B${firstRow}:B${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "cellIs", operator: "greaterThan", formula: "0", style: { font: { color: GREEN, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "cellIs", operator: "lessThan", formula: "0", style: { font: { color: RED, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
    } catch { /* cosmetic */ }
  }
  [14, 18, 14, 16, 11, 22].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "6-Month Trend", ctx.generatedAt, ncols, lastRow);
}

// ── generic value heat-matrix (row dim × col dim; live SUMIFS; 3-colour scale) ────
function buildHeatMatrix(ctx: Ctx, opts: {
  sheetName: string;
  title: string;
  rowHeader: string;
  rows: { code: string; label: string; total: number }[];
  cols: { code: string; label: string }[];
  rowCrit: keyof typeof DATA;
  colCrit: keyof typeof DATA;
}) {
  const sheet = ctx.wb.addSheet(opts.sheetName);
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const totalCol = opts.cols.length + 2;
  const ncols = Math.max(3, totalCol);
  bandHeader(sheet, ncols, opts.title, ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  // Rotated 45° column headers (the loved Region×Product look) on a tall header row so the diagonal
  // labels never clip; the row-dimension header and the Total header stay horizontal for legibility.
  const headerRotStyle: CS = { ...headerStyle, alignment: { vertical: "bottom", horizontal: "left", textRotation: 45, indent: 1 } };
  sheet.setValue(headerRow, 1, opts.rowHeader); sheet.setStyle(headerRow, 1, headerStyle);
  opts.cols.forEach((c, i) => { sheet.setValue(headerRow, 2 + i, cleanText(c.label)); sheet.setStyle(headerRow, 2 + i, headerRotStyle); });
  sheet.setValue(headerRow, totalCol, "Total"); sheet.setStyle(headerRow, totalCol, headerRightStyle);
  sheet.setRowHeight(headerRow, 96);
  const firstRow = headerRow + 1;
  opts.rows.forEach((r, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, cleanText(r.label)); sheet.setStyle(row, 1, textCell(false, zebra));
    opts.cols.forEach((c, j) => {
      putMetric(ctx, sheet, row, 2 + j, sumifs1("Value", ctx.last, [[opts.rowCrit, r.code], [opts.colCrit, c.code]]), 0);
      sheet.setStyle(row, 2 + j, numCell(F_VALUE, zebra));
    });
    putMetric(ctx, sheet, row, totalCol, sumifs1("Value", ctx.last, [[opts.rowCrit, r.code]]), r.total);
    sheet.setStyle(row, totalCol, numCell(F_VALUE, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + opts.rows.length - 1);
  const totalRow = lastRow + 1;
  if (opts.rows.length === 0 || opts.cols.length === 0) {
    noteRow(sheet, firstRow, "No data for the current selection.");
  } else {
    sheet.setValue(totalRow, 1, "TOTAL"); sheet.setStyle(totalRow, 1, totalStyle);
    for (let c = 2; c <= totalCol; c += 1) {
      sheet.setFormula(totalRow, c, `SUM(${colLetter(c)}${firstRow}:${colLetter(c)}${lastRow})`);
      sheet.setStyle(totalRow, c, totalNumStyle(F_VALUE));
    }
    try {
      sheet.addConditionalFormat({
        sqref: `B${firstRow}:${colLetter(totalCol - 1)}${lastRow}`,
        type: "colorScale",
        colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, ORANGE_DEEP] },
        priority: cfp(),
      });
    } catch { /* cosmetic */ }
  }
  // Rotated headers let the value columns stay narrow; widths chosen so no-decimals money never
  // renders as ### (a tens-of-millions total fits in 15), with a slightly wider Total column.
  sheet.setColumnWidth(1, 26);
  for (let c = 2; c < totalCol; c += 1) sheet.setColumnWidth(c, 13);
  sheet.setColumnWidth(totalCol, 15);
  sheet.freeze(headerRow, 1);
  applyPrintSetup(sheet, opts.title, ctx.generatedAt, ncols, totalRow);
}

// ── Pareto ABC (live value + share; REPT bar; cumulative/class from the payload) ──
function buildParetoAbc(ctx: Ctx): SheetRanges {
  const sheet = ctx.wb.addSheet("Pareto ABC");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 8;
  bandHeader(sheet, ncols, "Product Pareto — ABC Classification", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["#", "Product", "Line", "Value (EGP)", "Bar", "Share %", "Cumulative %", "Class"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 3 || i === 5 || i === 6 ? headerRightStyle : headerStyle);
  });
  const pareto = ctx.data.paretoProducts ?? [];
  const firstRow = headerRow + 1;
  const lastRow = Math.max(firstRow, firstRow + pareto.length - 1);
  pareto.forEach((p, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, cleanText(p.label)); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setValue(row, 3, cleanText(p.line ?? "")); sheet.setStyle(row, 3, textCell(false, zebra));
    putMetric(ctx, sheet, row, 4, sumifs1("Value", ctx.last, [["ProductCode", p.code]]), p.value);
    sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
    sheet.setFormula(row, 5, `IFERROR(REPT("|",ROUND(D${row}/MAX($D$${firstRow}:$D$${lastRow})*16,0)),"")`);
    sheet.setStyle(row, 5, barCell(zebra));
    sheet.setFormula(row, 6, div0(`D${row}`, `SUM($D$${firstRow}:$D$${lastRow})`));
    sheet.setStyle(row, 6, numCell(F_PCT, zebra));
    sheet.setValue(row, 7, p.cumulativeShare); sheet.setStyle(row, 7, numCell(F_PCT, zebra));
    sheet.setValue(row, 8, p.abcClass); sheet.setStyle(row, 8, textCell(true, zebra));
  });
  if (pareto.length === 0) {
    noteRow(sheet, firstRow, "Pareto analysis unavailable for this payload.");
  } else {
    try {
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `G${firstRow}:G${lastRow}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "min" }, { type: "percent", val: "50" }, { type: "max" }], color: [GREEN, AMBER, RED] }, priority: cfp() });
    } catch { /* cosmetic */ }
    const counts = { A: 0, B: 0, C: 0 };
    for (const p of pareto) counts[p.abcClass] += 1;
    noteRow(sheet, lastRow + 2, `Class A: ${counts.A} product(s) = 80% of value · Class B: ${counts.B} (to 95%) · Class C: ${counts.C} (the tail).`);
    // ABC split — live SUMIF totals per class (recalculate with the table) + chart.
    const splitTitle = lastRow + 4;
    sheet.setValue(splitTitle, 1, "ABC SPLIT — value by class");
    sheet.setStyle(splitTitle, 1, { font: { bold: true, size: 11, color: ORANGE_DEEP, name: "Calibri" }, alignment: { vertical: "center", indent: 1 } });
    const splitFirst = splitTitle + 1;
    (["A", "B", "C"] as const).forEach((cls, i) => {
      const r = splitFirst + i;
      sheet.setValue(r, 1, `Class ${cls}`); sheet.setStyle(r, 1, textCell(true, i % 2 === 1));
      sheet.setFormula(r, 2, `SUMIF($H$${firstRow}:$H$${lastRow},"${cls}",$D$${firstRow}:$D$${lastRow})`);
      sheet.setStyle(r, 2, numCell(F_VALUE, i % 2 === 1));
    });
    try {
      sheet.addChart({
        type: "column", title: "ABC Split — value by class",
        series: [{ name: "Value", color: ORANGE, values: `'Pareto ABC'!$B$${splitFirst}:$B$${splitFirst + 2}`, categories: `'Pareto ABC'!$A$${splitFirst}:$A$${splitFirst + 2}` }],
        from: { col: 3, row: splitTitle }, to: { col: 8, row: splitTitle + 15 }, legend: false, varyColors: true, roundedCorners: true, chartFill: "white", colorPalette: "orange", dataLabels: { showValue: true, numFmt: "#,##0" },
      });
    } catch { /* chart best-effort */ }
  }
  [5, 34, 16, 18, 20, 11, 14, 8].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  try { sheet.setAutoFilter(`A${headerRow}:${colLetter(ncols)}${lastRow}`); } catch { /* cosmetic */ }
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "Pareto ABC", ctx.generatedAt, ncols, pareto.length === 0 ? lastRow + 2 : lastRow + 7);
  return { sheetName: "Pareto ABC", firstRow, lastRow, nameCol: 2, valueCol: 4, count: pareto.length };
}

// ── Region Pareto (each region's own 80/20; collapsible outline + REPT bars) ──────
function buildRegionPareto(ctx: Ctx, tree: RegionNode[]) {
  const title = "Region Pareto (80/20 per region)";
  const sheet = ctx.wb.addSheet("Region Pareto", { outlineSummaryBelow: false });
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 6;
  bandHeader(sheet, ncols, title, ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["Region / Product", "Value (EGP)", "Bar", "Cumulative", "Cumulative %", "80% Line"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 1 && i !== 2 ? headerRightStyle : headerStyle);
  });
  let row = headerRow + 1;
  const firstBody = row;
  if (tree.length === 0) {
    noteRow(sheet, row, "No region-level product detail in scope.");
    row += 1;
  }
  for (const reg of tree) {
    const regRow = row;
    sheet.setValue(regRow, 1, reg.name); sheet.setStyle(regRow, 1, { font: { bold: true, color: WHITE, name: "Calibri", size: 11 }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
    putMetric(ctx, sheet, regRow, 2, sumifs1("Value", ctx.last, [["RegionCode", reg.code]]), reg.value);
    sheet.setStyle(regRow, 2, totalNumStyle(F_VALUE));
    for (let c = 3; c <= ncols; c += 1) sheet.setStyle(regRow, c, { fill: fill(SLATE_800) });
    row += 1;
    const prodFirst = row;
    const prodLast = row + reg.products.length - 1;
    reg.products.forEach((p, i) => {
      const zebra = i % 2 === 1;
      sheet.setValue(row, 1, p.name); sheet.setStyle(row, 1, { ...textCell(false, zebra), alignment: { vertical: "center", indent: 3 } });
      putMetric(ctx, sheet, row, 2, sumifs1("Value", ctx.last, [["RegionCode", reg.code], ["ProductCode", p.code]]), p.value);
      sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
      sheet.setFormula(row, 3, `IFERROR(REPT("|",ROUND(B${row}/MAX($B$${prodFirst}:$B$${prodLast})*14,0)),"")`);
      sheet.setStyle(row, 3, barCell(zebra));
      sheet.setFormula(row, 4, `SUM($B$${prodFirst}:B${row})`); sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
      sheet.setFormula(row, 5, div0(`D${row}`, `B${regRow}`)); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
      sheet.setFormula(row, 6, `IF(E${row}>=0.8,IF(${i === 0 ? "TRUE" : `E${row - 1}<0.8`},"◄ 80%",""),"")`);
      sheet.setStyle(row, 6, { font: { color: ORANGE_DEEP, bold: true, name: "Calibri", size: 10.5 }, alignment: { vertical: "center", indent: 1 } });
      groupRow(sheet, row, 1);
      row += 1;
    });
    if (prodLast >= prodFirst) {
      try {
        sheet.addConditionalFormat({ sqref: `B${prodFirst}:B${prodLast}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
        sheet.addConditionalFormat({ sqref: `E${prodFirst}:E${prodLast}`, type: "cellIs", operator: "greaterThanOrEqual", formula: "0.8", style: { fill: fill(AMBER) }, priority: cfp() });
      } catch { /* cosmetic */ }
    }
  }
  const bodyLast = Math.max(firstBody, row - 1);
  [42, 18, 18, 18, 14, 10].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(headerRow, 1);
  applyPrintSetup(sheet, title, ctx.generatedAt, ncols, bodyLast);
}

// ── Growth Contribution (who moved the total; hi-lo cellIs on the deltas) ─────────
function buildGrowthContribution(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("Growth Contribution");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 5;
  bandHeader(sheet, ncols, "Growth Contribution — share of the total month-over-month move", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  let row = 4;
  let lastUsed = 5;
  const contribution = ctx.mom?.contribution ?? null;
  if (!contribution) {
    noteRow(sheet, 5, (ctx.data.selectedPeriods?.length ?? 0) > 1
      ? "Multi-month selection — contribution analysis applies to single-month views only."
      : "No prior validated period — contribution analysis needs two months.");
  } else {
    const writeContribution = (title: string, rows: SosContributionRow[]) => {
      row = sectionTitle(sheet, row, ncols, title);
      const headerRow = row;
      ["Name", `Curr (${ctx.period})`, `Prev (${ctx.priorPeriod ?? "—"})`, "Δ value", "Contribution %"].forEach((h, i) => {
        sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 0 ? headerStyle : headerRightStyle);
      });
      row += 1;
      if (rows.length === 0) { noteRow(sheet, row, "None."); lastUsed = row; row += 2; return; }
      const first = row;
      rows.forEach((r, i) => {
        const zebra = i % 2 === 1;
        sheet.setValue(row, 1, cleanText(r.label)); sheet.setStyle(row, 1, textCell(false, zebra));
        sheet.setValue(row, 2, r.value); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
        sheet.setValue(row, 3, r.prevValue); sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
        sheet.setValue(row, 4, r.delta); sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
        sheet.setValue(row, 5, r.contribution); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
        row += 1;
      });
      const lastRow = row - 1;
      try {
        sheet.addConditionalFormat({ sqref: `D${first}:D${lastRow}`, type: "cellIs", operator: "greaterThan", formula: "0", style: { font: { color: GREEN, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
        sheet.addConditionalFormat({ sqref: `D${first}:D${lastRow}`, type: "cellIs", operator: "lessThan", formula: "0", style: { font: { color: RED, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
        sheet.addConditionalFormat({ sqref: `E${first}:E${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: BLUE, showValue: true }, priority: cfp() });
      } catch { /* cosmetic */ }
      lastUsed = lastRow;
      row += 1;
    };
    writeContribution("By product — largest movers of the total change", contribution.products);
    writeContribution("By region — largest movers of the total change", contribution.regions);
  }
  [34, 18, 18, 16, 15].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(3, 0);
  applyPrintSetup(sheet, "Growth Contribution", ctx.generatedAt, ncols, Math.max(5, lastUsed));
}

// ── Outliers (|z| ≥ 2; hi-lo cellIs flags on the z column) ────────────────────────
function buildOutliers(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("Outliers");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 4;
  bandHeader(sheet, ncols, "Statistical Outliers (|z| >= 2 within the current selection)", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const productOutliers = computeOutliers(ctx.data.byProduct);
  const regionOutliers = computeOutliers(ctx.data.byRegion);
  let row = 4;
  let lastUsed = 5;
  if (productOutliers.length === 0 && regionOutliers.length === 0) {
    noteRow(sheet, 5, "No statistical outliers — every product and region sits within 2 standard deviations.");
  } else {
    const writeOutliers = (title: string, rows: typeof productOutliers) => {
      row = sectionTitle(sheet, row, ncols, title);
      const headerRow = row;
      ["Name", "Value (EGP)", "Z-score", "Flag"].forEach((h, i) => {
        sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 1 || i === 2 ? headerRightStyle : headerStyle);
      });
      row += 1;
      if (rows.length === 0) { noteRow(sheet, row, "None."); lastUsed = row; row += 2; return; }
      const first = row;
      rows.forEach((r, i) => {
        const zebra = i % 2 === 1;
        sheet.setValue(row, 1, cleanText(r.label)); sheet.setStyle(row, 1, textCell(false, zebra));
        sheet.setValue(row, 2, r.value); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
        sheet.setValue(row, 3, r.z); sheet.setStyle(row, 3, numCell(F_Z, zebra));
        sheet.setValue(row, 4, r.direction === "high" ? "ABOVE (high)" : "BELOW (low)"); sheet.setStyle(row, 4, textCell(true, zebra));
        row += 1;
      });
      const lastRow = row - 1;
      try {
        sheet.addConditionalFormat({ sqref: `C${first}:C${lastRow}`, type: "cellIs", operator: "greaterThan", formula: "2", style: { fill: fill(RED), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
        sheet.addConditionalFormat({ sqref: `C${first}:C${lastRow}`, type: "cellIs", operator: "lessThan", formula: "-2", style: { fill: fill(BLUE), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      } catch { /* cosmetic */ }
      lastUsed = lastRow;
      row += 1;
    };
    writeOutliers("Product value outliers", productOutliers);
    writeOutliers("Region value outliers", regionOutliers);
  }
  [34, 18, 11, 14].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(3, 0);
  applyPrintSetup(sheet, "Outliers", ctx.generatedAt, ncols, Math.max(5, lastUsed));
}

// ── Coverage (Region × Line; hard-zero red + colour scale + traffic-light icons) ──
function buildCoverage(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("Coverage");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const lines = ctx.data.byLine.slice(0, 12);
  const regions = ctx.data.byRegion;
  const coveredCol = lines.length + 2;
  const pctCol = coveredCol + 1;
  const ncols = Math.max(3, pctCol);
  bandHeader(sheet, ncols, "Coverage Traffic-Lights — value by Region × Line", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  sheet.setValue(headerRow, 1, "Region"); sheet.setStyle(headerRow, 1, headerStyle);
  lines.forEach((l, i) => { sheet.setValue(headerRow, 2 + i, cleanText(l.label)); sheet.setStyle(headerRow, 2 + i, headerRightStyle); });
  sheet.setValue(headerRow, coveredCol, "Lines w/ Sales"); sheet.setStyle(headerRow, coveredCol, headerRightStyle);
  sheet.setValue(headerRow, pctCol, "Coverage %"); sheet.setStyle(headerRow, pctCol, headerRightStyle);
  const firstRow = headerRow + 1;
  regions.forEach((r, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, cleanText(r.label)); sheet.setStyle(row, 1, textCell(false, zebra));
    lines.forEach((l, j) => {
      putMetric(ctx, sheet, row, 2 + j, sumifs1("Value", ctx.last, [["RegionCode", r.code], ["Line", l.code]]), 0);
      sheet.setStyle(row, 2 + j, numCell(F_VALUE, zebra));
    });
    if (lines.length > 0) {
      const terms = lines.map((_, j) => `(${colLetter(2 + j)}${row}>0)`);
      sheet.setFormula(row, coveredCol, terms.join("+"));
      sheet.setStyle(row, coveredCol, numCell(F_UNITS, zebra));
      sheet.setFormula(row, pctCol, `IFERROR(${colLetter(coveredCol)}${row}/${lines.length},0)`);
      sheet.setStyle(row, pctCol, numCell(F_PCT, zebra));
    }
  });
  const lastRow = Math.max(firstRow, firstRow + regions.length - 1);
  if (regions.length === 0 || lines.length === 0) {
    noteRow(sheet, firstRow, "No region/line detail for the current selection.");
  } else {
    try {
      // Highest priority: hard-red the true zeros so coverage gaps are unmissable.
      sheet.addConditionalFormat({ sqref: `B${firstRow}:${colLetter(coveredCol - 1)}${lastRow}`, type: "cellIs", operator: "equal", formula: "0", style: { fill: fill(RED), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `B${firstRow}:${colLetter(coveredCol - 1)}${lastRow}`, type: "colorScale", colorScale: { type: "colorScale", cfvo: [{ type: "num", val: "0" }, { type: "percent", val: "50" }, { type: "max" }], color: ["FFFFFFFF", AMBER, GREEN] }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `${colLetter(pctCol)}${firstRow}:${colLetter(pctCol)}${lastRow}`, type: "iconSet", iconSet: { type: "iconSet", iconSet: "3TrafficLights1", cfvo: [{ type: "percent", val: "0" }, { type: "percent", val: "33" }, { type: "percent", val: "67" }] }, priority: cfp() });
    } catch { /* cosmetic */ }
    noteRow(sheet, lastRow + 2, "Red cell = no sales for that line in the region. Traffic light = share of lines with sales.");
  }
  sheet.setColumnWidth(1, 26);
  for (let c = 2; c < coveredCol; c += 1) sheet.setColumnWidth(c, 14);
  sheet.setColumnWidth(coveredCol, 15); sheet.setColumnWidth(pctCol, 13);
  sheet.freeze(headerRow, 1);
  applyPrintSetup(sheet, "Coverage", ctx.generatedAt, ncols, lastRow + 2);
}

// ── Region Drill (collapsible Region → Product outline; live SUMIFS) ──────────────
function buildRegionDrill(ctx: Ctx, tree: RegionNode[]) {
  const title = "Region Drill (Region → Product)";
  const sheet = ctx.wb.addSheet("Region Drill", { outlineSummaryBelow: false });
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 5;
  bandHeader(sheet, ncols, title, ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["Region / Product", "Value (EGP)", "Units", "% of Region", "% of Total"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 0 ? headerStyle : headerRightStyle);
  });
  const valTotal = `SUM(${dataRange("Value", ctx.last)})`;
  let row = headerRow + 1;
  const firstBody = row;
  if (tree.length === 0) {
    noteRow(sheet, row, "No region-level detail in scope.");
    row += 1;
  }
  for (const reg of tree) {
    const regRow = row;
    sheet.setValue(regRow, 1, reg.name); sheet.setStyle(regRow, 1, { font: { bold: true, color: WHITE, name: "Calibri", size: 11 }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
    putMetric(ctx, sheet, regRow, 2, sumifs1("Value", ctx.last, [["RegionCode", reg.code]]), reg.value);
    sheet.setStyle(regRow, 2, totalNumStyle(F_VALUE));
    putMetric(ctx, sheet, regRow, 3, sumifs1("Units", ctx.last, [["RegionCode", reg.code]]), reg.units);
    sheet.setStyle(regRow, 3, totalNumStyle(F_UNITS));
    sheet.setValue(regRow, 4, 1); sheet.setStyle(regRow, 4, totalNumStyle(F_PCT));
    sheet.setFormula(regRow, 5, div0(`B${regRow}`, valTotal)); sheet.setStyle(regRow, 5, totalNumStyle(F_PCT));
    row += 1;
    const detailFirst = row;
    reg.products.forEach((p, i) => {
      const zebra = i % 2 === 1;
      sheet.setValue(row, 1, p.name); sheet.setStyle(row, 1, { ...textCell(false, zebra), alignment: { vertical: "center", indent: 3 } });
      putMetric(ctx, sheet, row, 2, sumifs1("Value", ctx.last, [["RegionCode", reg.code], ["ProductCode", p.code]]), p.value);
      sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
      putMetric(ctx, sheet, row, 3, sumifs1("Units", ctx.last, [["RegionCode", reg.code], ["ProductCode", p.code]]), p.units);
      sheet.setStyle(row, 3, numCell(F_UNITS, zebra));
      sheet.setFormula(row, 4, div0(`B${row}`, `B${regRow}`)); sheet.setStyle(row, 4, numCell(F_PCT, zebra));
      sheet.setFormula(row, 5, div0(`B${row}`, valTotal)); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
      groupRow(sheet, row, 1);
      row += 1;
    });
    if (row - 1 >= detailFirst) {
      try { sheet.addConditionalFormat({ sqref: `D${detailFirst}:D${row - 1}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() }); } catch { /* cosmetic */ }
    }
  }
  const bodyLast = Math.max(firstBody, row - 1);
  sheet.setColumnWidth(1, 42); [2, 3].forEach((c) => sheet.setColumnWidth(c, 18)); sheet.setColumnWidth(4, 13); sheet.setColumnWidth(5, 13);
  sheet.freeze(headerRow, 1);
  applyPrintSetup(sheet, title, ctx.generatedAt, ncols, bodyLast);
}

// ── generic breakdown sheet (live SUMIFS metrics + share; MoM Δ% from the payload) ─
function buildBreakdown(ctx: Ctx, opts: {
  sheetName: string;
  title: string;
  dimLabel: string;
  critKey: keyof typeof DATA;
  dims: { code: string; label: string; value: number; units: number }[];
  momPct: Map<string, number>;
}): SheetRanges {
  const sheet = ctx.wb.addSheet(opts.sheetName);
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 6;
  bandHeader(sheet, ncols, opts.title, ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["#", opts.dimLabel, "Value (EGP)", "Units", "Share %", "MoM Δ %"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 2 ? headerRightStyle : headerStyle);
  });
  const firstRow = headerRow + 1;
  const lastRow = Math.max(firstRow, firstRow + opts.dims.length - 1);
  opts.dims.forEach((d, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, cleanText(d.label)); sheet.setStyle(row, 2, textCell(false, zebra));
    putMetric(ctx, sheet, row, 3, sumifs1("Value", ctx.last, [[opts.critKey, d.code]]), d.value);
    sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
    putMetric(ctx, sheet, row, 4, sumifs1("Units", ctx.last, [[opts.critKey, d.code]]), d.units);
    sheet.setStyle(row, 4, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 5, div0(`C${row}`, `SUM($C$${firstRow}:$C$${lastRow})`)); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
    const pct = opts.momPct.get(d.code.toUpperCase());
    if (typeof pct === "number") sheet.setValue(row, 6, pct);
    sheet.setStyle(row, 6, numCell(F_PCT, zebra));
  });
  const totalRow = lastRow + 1;
  if (opts.dims.length === 0) {
    noteRow(sheet, firstRow, "No data for the current selection.");
  } else {
    sheet.setStyle(totalRow, 1, totalStyle);
    sheet.setValue(totalRow, 2, "TOTAL"); sheet.setStyle(totalRow, 2, totalStyle);
    sheet.setFormula(totalRow, 3, `SUM(C${firstRow}:C${lastRow})`); sheet.setStyle(totalRow, 3, totalNumStyle(F_VALUE));
    sheet.setFormula(totalRow, 4, `SUM(D${firstRow}:D${lastRow})`); sheet.setStyle(totalRow, 4, totalNumStyle(F_UNITS));
    sheet.setValue(totalRow, 5, 1); sheet.setStyle(totalRow, 5, totalNumStyle(F_PCT));
    sheet.setValue(totalRow, 6, ""); sheet.setStyle(totalRow, 6, totalStyle);
    try { sheet.addConditionalFormat({ sqref: `C${firstRow}:C${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() }); } catch { /* cosmetic */ }
  }
  [5, 34, 18, 14, 11, 11].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  try { sheet.setAutoFilter(`A${headerRow}:${colLetter(ncols)}${lastRow}`); } catch { /* cosmetic */ }
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, opts.title, ctx.generatedAt, ncols, totalRow);
  return { sheetName: opts.sheetName, firstRow, lastRow, nameCol: 2, valueCol: 3, count: opts.dims.length };
}

// ── Distributors (breakdown + reach columns) ──────────────────────────────────────
function buildDistributors(ctx: Ctx, momPct: Map<string, number>): SheetRanges {
  const sheet = ctx.wb.addSheet("Distributors");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 9;
  bandHeader(sheet, ncols, "By Distributor", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["#", "Distributor", "Value (EGP)", "Units", "Share %", "MoM Δ %", "Regions", "Areas", "Products"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 2 ? headerRightStyle : headerStyle);
  });
  const dims = ctx.data.byDistributor;
  const firstRow = headerRow + 1;
  const lastRow = Math.max(firstRow, firstRow + dims.length - 1);
  dims.forEach((d, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, cleanText(d.label)); sheet.setStyle(row, 2, textCell(false, zebra));
    putMetric(ctx, sheet, row, 3, sumifs1("Value", ctx.last, [["DistCode", d.code]]), d.value);
    sheet.setStyle(row, 3, numCell(F_VALUE, zebra));
    putMetric(ctx, sheet, row, 4, sumifs1("Units", ctx.last, [["DistCode", d.code]]), d.units);
    sheet.setStyle(row, 4, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 5, div0(`C${row}`, `SUM($C$${firstRow}:$C$${lastRow})`)); sheet.setStyle(row, 5, numCell(F_PCT, zebra));
    const pct = momPct.get(d.code.toUpperCase());
    if (typeof pct === "number") sheet.setValue(row, 6, pct);
    sheet.setStyle(row, 6, numCell(F_PCT, zebra));
    sheet.setValue(row, 7, d.regions); sheet.setStyle(row, 7, numCell(F_UNITS, zebra));
    sheet.setValue(row, 8, d.areas); sheet.setStyle(row, 8, numCell(F_UNITS, zebra));
    sheet.setValue(row, 9, d.products); sheet.setStyle(row, 9, numCell(F_UNITS, zebra));
  });
  const totalRow = lastRow + 1;
  if (dims.length === 0) {
    noteRow(sheet, firstRow, "No distributor rows for the current selection.");
  } else {
    sheet.setStyle(totalRow, 1, totalStyle);
    sheet.setValue(totalRow, 2, "TOTAL"); sheet.setStyle(totalRow, 2, totalStyle);
    sheet.setFormula(totalRow, 3, `SUM(C${firstRow}:C${lastRow})`); sheet.setStyle(totalRow, 3, totalNumStyle(F_VALUE));
    sheet.setFormula(totalRow, 4, `SUM(D${firstRow}:D${lastRow})`); sheet.setStyle(totalRow, 4, totalNumStyle(F_UNITS));
    for (let c = 5; c <= ncols; c += 1) { sheet.setValue(totalRow, c, ""); sheet.setStyle(totalRow, c, totalStyle); }
    try { sheet.addConditionalFormat({ sqref: `C${firstRow}:C${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() }); } catch { /* cosmetic */ }
  }
  [5, 34, 18, 14, 11, 11, 10, 10, 10].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  try { sheet.setAutoFilter(`A${headerRow}:${colLetter(ncols)}${lastRow}`); } catch { /* cosmetic */ }
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "By Distributor", ctx.generatedAt, ncols, totalRow);
  return { sheetName: "Distributors", firstRow, lastRow, nameCol: 2, valueCol: 3, count: dims.length };
}

// ── Areas (breakdown + SOLD / WHITE-SPACE status; hard-zero red on value) ─────────
function buildAreas(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("Areas");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 7;
  bandHeader(sheet, ncols, "By Area — coverage view", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["#", "Area", "Region", "Value (EGP)", "Units", "Share %", "Status"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 3 && i !== 6 ? headerRightStyle : headerStyle);
  });
  const whiteSpaceCodes = new Set(ctx.data.whiteSpaceAreas.map((a) => a.code.toUpperCase()));
  const dims = ctx.data.byArea;
  const firstRow = headerRow + 1;
  const lastRow = Math.max(firstRow, firstRow + dims.length - 1);
  dims.forEach((d, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, cleanText(d.label)); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setValue(row, 3, cleanText(d.line ?? "")); sheet.setStyle(row, 3, textCell(false, zebra));
    putMetric(ctx, sheet, row, 4, sumifs1("Value", ctx.last, [["AreaCode", d.code]]), d.value);
    sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
    putMetric(ctx, sheet, row, 5, sumifs1("Units", ctx.last, [["AreaCode", d.code]]), d.units);
    sheet.setStyle(row, 5, numCell(F_UNITS, zebra));
    sheet.setFormula(row, 6, div0(`D${row}`, `SUM($D$${firstRow}:$D$${lastRow})`)); sheet.setStyle(row, 6, numCell(F_PCT, zebra));
    sheet.setValue(row, 7, whiteSpaceCodes.has(d.code.toUpperCase()) ? "WHITE-SPACE" : "SOLD"); sheet.setStyle(row, 7, textCell(true, zebra));
  });
  if (dims.length === 0) {
    noteRow(sheet, firstRow, "No area rows for the current selection.");
  } else {
    try {
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "cellIs", operator: "equal", formula: "0", style: { fill: fill(RED), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() });
    } catch { /* cosmetic */ }
  }
  [5, 28, 18, 18, 14, 11, 14].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  try { sheet.setAutoFilter(`A${headerRow}:${colLetter(ncols)}${lastRow}`); } catch { /* cosmetic */ }
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "By Area", ctx.generatedAt, ncols, lastRow);
}

// ── Top Customers (customer grain is not in the leaf Data table → plain values) ───
function buildTopCustomers(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("Top Customers");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 9;
  bandHeader(sheet, ncols, "Top Customers", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  // Share % is the payload's server-computed share of the FULL customer base — an
  // in-sheet ratio over the visible top-15 would understate the true denominator.
  ["#", "Customer", "Code", "Distributor", "Region", "Area", "Value (EGP)", "Units", "Share %"].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i >= 6 ? headerRightStyle : headerStyle);
  });
  const firstRow = headerRow + 1;
  const customers = ctx.data.topCustomers;
  customers.forEach((c, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, i + 1); sheet.setStyle(row, 1, numCell(F_UNITS, zebra));
    sheet.setValue(row, 2, cleanText(c.name)); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setValue(row, 3, cleanText(c.code)); sheet.setStyle(row, 3, textCell(false, zebra));
    sheet.setValue(row, 4, cleanText(c.distributor)); sheet.setStyle(row, 4, textCell(false, zebra));
    sheet.setValue(row, 5, cleanText(c.region)); sheet.setStyle(row, 5, textCell(false, zebra));
    sheet.setValue(row, 6, cleanText(c.area)); sheet.setStyle(row, 6, textCell(false, zebra));
    sheet.setValue(row, 7, c.value); sheet.setStyle(row, 7, numCell(F_VALUE, zebra));
    sheet.setValue(row, 8, c.units); sheet.setStyle(row, 8, numCell(F_UNITS, zebra));
    sheet.setValue(row, 9, c.share); sheet.setStyle(row, 9, numCell(F_PCT, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + customers.length - 1);
  if (customers.length === 0) {
    noteRow(sheet, firstRow, "No customer detail for the current selection.");
  } else {
    try { sheet.addConditionalFormat({ sqref: `G${firstRow}:G${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() }); } catch { /* cosmetic */ }
    noteRow(sheet, lastRow + 2, `Top-10 customer concentration: ${(ctx.data.customerTop10Share * 100).toFixed(1)}% of customer value.`);
  }
  [5, 34, 14, 22, 16, 16, 18, 13, 11].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  try { sheet.setAutoFilter(`A${headerRow}:${colLetter(ncols)}${lastRow}`); } catch { /* cosmetic */ }
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "Top Customers", ctx.generatedAt, ncols, lastRow + 2);
}

// ── Bricks (brick grain is not in the leaf Data table → plain values) ─────────────
function buildBricks(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("Bricks");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 4;
  bandHeader(sheet, ncols, "Brick Performance", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  let row = 4;
  let lastUsed = 5;
  const writeBricks = (title: string, rows: SosDashboardData["topBricks"]) => {
    row = sectionTitle(sheet, row, ncols, title);
    const headerRow = row;
    ["Brick", "Value (EGP)", "Units", "Share %"].forEach((h, i) => {
      sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 0 ? headerStyle : headerRightStyle);
    });
    row += 1;
    if (rows.length === 0) { noteRow(sheet, row, "None."); lastUsed = row; row += 2; return; }
    const first = row;
    rows.forEach((b, i) => {
      const zebra = i % 2 === 1;
      sheet.setValue(row, 1, cleanText(b.label)); sheet.setStyle(row, 1, textCell(false, zebra));
      sheet.setValue(row, 2, b.value); sheet.setStyle(row, 2, numCell(F_VALUE, zebra));
      sheet.setValue(row, 3, b.units); sheet.setStyle(row, 3, numCell(F_UNITS, zebra));
      sheet.setValue(row, 4, b.share); sheet.setStyle(row, 4, numCell(F_PCT, zebra));
      row += 1;
    });
    const lastRow = row - 1;
    try { sheet.addConditionalFormat({ sqref: `B${first}:B${lastRow}`, type: "dataBar", dataBar: { type: "dataBar", color: ORANGE, showValue: true }, priority: cfp() }); } catch { /* cosmetic */ }
    lastUsed = lastRow;
    row += 1;
  };
  writeBricks("Top bricks", ctx.data.topBricks);
  writeBricks("Bottom bricks (non-zero)", ctx.data.bottomBricks);
  [30, 18, 13, 11].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(3, 0);
  applyPrintSetup(sheet, "Bricks", ctx.generatedAt, ncols, Math.max(5, lastUsed));
}

// ── White-space (zero-sales areas; hard-zero red proves the gap live) ─────────────
function buildWhiteSpace(ctx: Ctx) {
  const sheet = ctx.wb.addSheet("White-space");
  sheet.view = { showGridLines: false };
  const cfp = makeCfPriority();
  const ncols = 4;
  bandHeader(sheet, ncols, "White-space Areas (zero distributor sales)", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["Area", "Region", "Area code", `Value (${ctx.period})`].forEach((h, i) => {
    sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, i === 3 ? headerRightStyle : headerStyle);
  });
  const areas = ctx.data.whiteSpaceAreas;
  const firstRow = headerRow + 1;
  areas.forEach((a, i) => {
    const row = firstRow + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, cleanText(a.label)); sheet.setStyle(row, 1, textCell(false, zebra));
    sheet.setValue(row, 2, cleanText(a.region ?? "")); sheet.setStyle(row, 2, textCell(false, zebra));
    sheet.setValue(row, 3, cleanText(a.code)); sheet.setStyle(row, 3, textCell(false, zebra));
    putMetric(ctx, sheet, row, 4, sumifs1("Value", ctx.last, [["AreaCode", a.code]]), 0);
    sheet.setStyle(row, 4, numCell(F_VALUE, zebra));
  });
  const lastRow = Math.max(firstRow, firstRow + areas.length - 1);
  if (areas.length === 0) {
    noteRow(sheet, firstRow, "No white-space areas — every area in scope has distributor sales.");
  } else {
    try {
      sheet.addConditionalFormat({ sqref: `D${firstRow}:D${lastRow}`, type: "cellIs", operator: "equal", formula: "0", style: { fill: fill(RED), font: { color: WHITE, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
    } catch { /* cosmetic */ }
    noteRow(sheet, lastRow + 2, "Coverage denominator is the viewer's scope (see Report Info). A red 0 confirms the gap against the live Data sheet.");
  }
  [30, 20, 14, 18].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "White-space", ctx.generatedAt, ncols, lastRow + 2);
}

// ── Report Info (provenance / scope / semantics) ──────────────────────────────────
function buildReportInfo(ctx: Ctx, generatedBy: string, filterSummary: string, leafCount: number) {
  const sheet = ctx.wb.addSheet("Report Info");
  sheet.view = { showGridLines: false };
  const ncols = 2;
  bandHeader(sheet, ncols, "Report Info", ctx.subtitle);
  addNavLink(sheet, 1, ncols + 1);
  const headerRow = 4;
  ["Field", "Value"].forEach((h, i) => { sheet.setValue(headerRow, i + 1, h); sheet.setStyle(headerRow, i + 1, headerStyle); });
  const rows: [string, string | number][] = [
    ["Report", "Source of Sales — Executive BI workbook"],
    ["Period(s)", ctx.period],
    ["Months in scope", (ctx.data.selectedPeriods ?? []).join(", ") || ctx.data.period || "—"],
    ["Prior period (MoM)", ctx.priorPeriod ?? "— (no prior validated period)"],
    ["Scope", "CEO / Super Admin — full company; confidential products per role policy"],
    ["Applied filters", cleanText(filterSummary)],
    ["Generated at", ctx.generatedAt],
    ["Generated by", cleanText(generatedBy)],
    ["Leaf rows (Data sheet)", leafCount],
    ["Bricks (reached / total in scope)", `${ctx.data.summary.bricksReached} / ${ctx.data.summary.totalBricks}`],
    ["Available periods", ctx.data.availablePeriods.join(", ") || "—"],
    ["Value semantics", "Distributor rows: qty × (1 − discount) × factory price. Direct rows: the stored sheet value. Bonus qty excluded."],
    ["Data sheet", "Hidden sheet 'Data' holds the exact scoped leaf rows as the native Excel Table tblSos; every reconstructable figure is a live SUMIFS/SUM formula over it."],
    ["Engine", "ExcelForge — native charts, table, icon-set / cellIs conditional formatting and outline drill-downs."],
  ];
  rows.forEach(([field, value], i) => {
    const row = headerRow + 1 + i, zebra = i % 2 === 1;
    sheet.setValue(row, 1, field); sheet.setStyle(row, 1, textCell(true, zebra));
    sheet.setValue(row, 2, typeof value === "number" ? value : cleanText(value)); sheet.setStyle(row, 2, textCell(false, zebra));
  });
  const lastRow = headerRow + rows.length;

  // Self-reconciliation — live SUM over the tblSos Value column vs the server-computed
  // total, with a pass/fail formula cell (green/red cellIs rules, unique priorities).
  const cfp = makeCfPriority();
  let recRow = sectionTitle(sheet, lastRow + 2, ncols, "SELF-RECONCILIATION — Data sheet vs server-computed totals");
  if (ctx.hasLeaf) {
    const liveRow = recRow, serverRow = recRow + 1, statusRow = recRow + 2;
    sheet.setValue(liveRow, 1, "Live SUM of tblSos Value column (Data sheet)"); sheet.setStyle(liveRow, 1, textCell(true));
    sheet.setFormula(liveRow, 2, `SUM(${dataRange("Value", ctx.last)})`); sheet.setStyle(liveRow, 2, numCell(F_VALUE));
    sheet.setValue(serverRow, 1, "Server-computed total value (EGP)"); sheet.setStyle(serverRow, 1, textCell(true, true));
    sheet.setValue(serverRow, 2, ctx.data.summary.totalValue); sheet.setStyle(serverRow, 2, numCell(F_VALUE, true));
    sheet.setValue(statusRow, 1, "Reconciliation status (tolerance < 1 EGP)"); sheet.setStyle(statusRow, 1, textCell(true));
    sheet.setFormula(statusRow, 2, `IF(ABS(B${liveRow}-B${serverRow})<1,"RECONCILED ✓","CHECK VALUES")`);
    sheet.setStyle(statusRow, 2, { font: { bold: true, size: 11, color: INK, name: "Calibri" }, alignment: { vertical: "center", horizontal: "left", indent: 1 }, border: border() });
    try {
      sheet.addConditionalFormat({ sqref: `B${statusRow}`, type: "cellIs", operator: "equal", formula: `"RECONCILED ✓"`, style: { fill: fill(GREEN), font: { color: WHITE, bold: true, name: "Calibri", size: 11 } }, priority: cfp() });
      sheet.addConditionalFormat({ sqref: `B${statusRow}`, type: "cellIs", operator: "equal", formula: `"CHECK VALUES"`, style: { fill: fill(RED), font: { color: WHITE, bold: true, name: "Calibri", size: 11 } }, priority: cfp() });
    } catch { /* cosmetic */ }
    recRow = statusRow;
  } else {
    noteRow(sheet, recRow, "Reconciliation unavailable — this export was generated without leaf detail rows.");
  }

  sheet.setColumnWidth(1, 42); sheet.setColumnWidth(2, 110);
  sheet.freeze(headerRow, 0);
  applyPrintSetup(sheet, "Report Info", ctx.generatedAt, ncols, recRow);
}

// ── Dashboard cover (KPI tiles + MoM table + insights + native charts + contents) ─
function buildDashboardCover(
  ctx: Ctx,
  dash: Worksheet,
  ranges: { products: SheetRanges; regions: SheetRanges; distributors: SheetRanges; pareto: SheetRanges },
) {
  const { data } = ctx;
  dash.view = { showGridLines: false };
  const cfp = makeCfPriority();
  bandHeader(dash, 12, `${systemIdentity.appName} — Source of Sales BI`, ctx.subtitle);

  const valRange = dataRange("Value", ctx.last);
  const unitRange = dataRange("Units", ctx.last);
  const tiles: { label: string; formula?: string; value: number; fmt: string }[] = [
    { label: "TOTAL VALUE (EGP)", formula: `SUM(${valRange})`, value: data.summary.totalValue, fmt: F_VALUE },
    { label: "TOTAL UNITS", formula: `SUM(${unitRange})`, value: data.summary.totalUnits, fmt: F_UNITS },
    { label: "AVG PRICE / UNIT", formula: div0(`SUM(${valRange})`, `SUM(${unitRange})`), value: data.summary.avgPricePerUnit, fmt: F_VALUE },
    { label: "DIRECT SHARE", value: data.summary.directShare, fmt: F_PCT },
    { label: "DISTRIBUTORS", value: data.summary.distributorCount, fmt: F_UNITS },
    { label: "PRODUCTS", value: data.summary.productCount, fmt: F_UNITS },
  ];
  tiles.forEach((t, i) => {
    const c = 1 + i * 2;
    dash.merge(5, c, 5, c + 1); dash.setValue(5, c, t.label);
    dash.setStyle(5, c, { font: { bold: true, size: 9, color: ORANGE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } });
    dash.setStyle(5, c + 1, { fill: fill(SLATE_900) });
    dash.merge(6, c, 6, c + 1);
    if (t.formula && ctx.hasLeaf) dash.setFormula(6, c, t.formula); else dash.setValue(6, c, t.value);
    dash.setStyle(6, c, { font: { bold: true, size: 17, color: WHITE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 }, numberFormat: { formatCode: t.fmt } });
    dash.setStyle(6, c + 1, { fill: fill(SLATE_900) });
    dash.setStyle(7, c, { fill: fill(ORANGE) }); dash.setStyle(7, c + 1, { fill: fill(ORANGE) });
  });
  dash.setRowHeight(5, 16); dash.setRowHeight(6, 30); dash.setRowHeight(7, 3);

  // Executive narrative — formula-driven (TEXT()/& over live cells) so it tracks the
  // data when edited; plain payload text when the leaf grain / top rows are absent.
  const fallbackNarrative = cleanText(
    `This report covers ${Math.round(data.summary.totalValue).toLocaleString("en-US")} EGP across ` +
    `${data.summary.distributorCount} distributors, ${data.byRegion.length} regions and ${data.summary.productCount} products.` +
    (data.byRegion[0] ? `  Top region: ${data.byRegion[0].label}.` : "") +
    (data.byProduct[0] ? `  Top product: ${data.byProduct[0].label}.` : ""),
  );
  dash.merge(9, 1, 10, 12);
  if (ctx.hasLeaf && ranges.regions.count > 0 && ranges.products.count > 0) {
    // Breakdown sheets are value-sorted → their first data row is the top entity.
    const topRegionName = `Regions!$B$${ranges.regions.firstRow}`, topRegionShare = `Regions!$E$${ranges.regions.firstRow}`;
    const topProductName = `Products!$B$${ranges.products.firstRow}`, topProductShare = `Products!$E$${ranges.products.firstRow}`;
    const narrative =
      `"This report covers "&TEXT(SUM(${valRange}),"#,##0")&" EGP across "&` +
      `TEXT(${data.summary.distributorCount},"#,##0")&" distributors, "&TEXT(${data.byRegion.length},"#,##0")&" regions and "&` +
      `TEXT(${data.summary.productCount},"#,##0")&" products.  Top region: "&${topRegionName}&" ("&TEXT(${topRegionShare},"0.0%")&` +
      `").  Top product: "&${topProductName}&" ("&TEXT(${topProductShare},"0.0%")&")."`;
    try { dash.setFormula(9, 1, `IFERROR(${narrative},"${esc(fallbackNarrative)}")`); }
    catch { dash.setValue(9, 1, fallbackNarrative); }
  } else {
    dash.setValue(9, 1, fallbackNarrative);
  }
  dash.setStyle(9, 1, { font: { size: 11, color: INK, name: "Calibri" }, alignment: { vertical: "center", horizontal: "left", indent: 1, wrapText: true }, fill: fill("FFFFF7ED") });
  dash.setRowHeight(9, 18); dash.setRowHeight(10, 18);

  // ── Headline KPIs (LEFT, cols A–D) and Executive insights (RIGHT, cols F–L) side by side —
  //    fills the horizontal band instead of leaving 8 empty columns beside a narrow KPI table. ──
  const bandRow = 12;
  const miniTitle = (col: number, span: number, label: string) => {
    dash.merge(bandRow, col, bandRow, col + span - 1);
    dash.setValue(bandRow, col, cleanText(label));
    dash.setStyle(bandRow, col, { font: { bold: true, size: 11, color: ORANGE, name: "Calibri" }, fill: fill(SLATE_800), alignment: { vertical: "center", indent: 1 } });
    for (let c = col + 1; c < col + span; c += 1) dash.setStyle(bandRow, c, { fill: fill(SLATE_800) });
  };
  miniTitle(1, 4, `Headline KPIs — ${ctx.period}${ctx.priorPeriod ? ` vs ${ctx.priorPeriod}` : ""}`);
  miniTitle(6, 7, "Executive insights");

  const kpiHeader = bandRow + 1;
  ["KPI", "Value", `Prior (${ctx.priorPeriod ?? "—"})`, "MoM Δ %"].forEach((h, i) => {
    dash.setValue(kpiHeader, i + 1, h); dash.setStyle(kpiHeader, i + 1, i === 0 ? headerStyle : headerRightStyle);
  });
  let row = kpiHeader + 1;
  const d = ctx.mom?.summaryDeltas ?? null;
  const kpis: { label: string; fmt: string; live?: string; value: number; prior: number | null; deltaPct: number | null }[] = [
    { label: "Total value (EGP)", fmt: F_VALUE, live: `SUM(${valRange})`, value: data.summary.totalValue, prior: d?.totalValue.previous ?? null, deltaPct: d?.totalValue.deltaPct ?? null },
    { label: "Total units", fmt: F_UNITS, live: `SUM(${unitRange})`, value: data.summary.totalUnits, prior: d?.totalUnits.previous ?? null, deltaPct: d?.totalUnits.deltaPct ?? null },
    { label: "Avg price / unit (EGP)", fmt: F_VALUE, live: div0(`SUM(${valRange})`, `SUM(${unitRange})`), value: data.summary.avgPricePerUnit, prior: d?.avgPricePerUnit.previous ?? null, deltaPct: d?.avgPricePerUnit.deltaPct ?? null },
    { label: "Direct value (EGP)", fmt: F_VALUE, live: sumifs1("Value", ctx.last, [["Channel", "Direct"]]), value: data.summary.directValue, prior: null, deltaPct: null },
    { label: "Distributor value (EGP)", fmt: F_VALUE, live: sumifs1("Value", ctx.last, [["Channel", "Distributor"]]), value: data.summary.distributorValue, prior: null, deltaPct: null },
    { label: "Direct share %", fmt: F_PCT, value: data.summary.directShare, prior: d?.directShare.previous ?? null, deltaPct: d?.directShare.deltaPct ?? null },
    { label: "Distributors", fmt: F_UNITS, value: data.summary.distributorCount, prior: d?.distributorCount.previous ?? null, deltaPct: d?.distributorCount.deltaPct ?? null },
    { label: "Products", fmt: F_UNITS, value: data.summary.productCount, prior: d?.productCount.previous ?? null, deltaPct: d?.productCount.deltaPct ?? null },
    { label: "Customers", fmt: F_UNITS, value: data.summary.customerCount, prior: null, deltaPct: null },
    { label: "Areas reached", fmt: F_UNITS, value: data.summary.areasReached, prior: d?.areasReached.previous ?? null, deltaPct: d?.areasReached.deltaPct ?? null },
    { label: "Total areas (scope)", fmt: F_UNITS, value: data.summary.totalAreas, prior: null, deltaPct: null },
    { label: "Bricks reached", fmt: F_UNITS, value: data.summary.bricksReached, prior: null, deltaPct: null },
    { label: "Total bricks (scope)", fmt: F_UNITS, value: data.summary.totalBricks, prior: null, deltaPct: null },
  ];
  const kpiFirst = row;
  kpis.forEach((k, i) => {
    const zebra = i % 2 === 1;
    dash.setValue(row, 1, k.label); dash.setStyle(row, 1, textCell(false, zebra));
    if (k.live && ctx.hasLeaf) dash.setFormula(row, 2, k.live); else dash.setValue(row, 2, k.value);
    dash.setStyle(row, 2, numCell(k.fmt, zebra));
    if (typeof k.prior === "number") dash.setValue(row, 3, k.prior);
    dash.setStyle(row, 3, numCell(k.fmt, zebra));
    if (typeof k.deltaPct === "number") dash.setValue(row, 4, k.deltaPct);
    dash.setStyle(row, 4, numCell(F_PCT, zebra));
    row += 1;
  });
  const kpiLast = row - 1;
  try {
    dash.addConditionalFormat({ sqref: `D${kpiFirst}:D${kpiLast}`, type: "cellIs", operator: "greaterThan", formula: "0", style: { font: { color: GREEN, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
    dash.addConditionalFormat({ sqref: `D${kpiFirst}:D${kpiLast}`, type: "cellIs", operator: "lessThan", formula: "0", style: { font: { color: RED, bold: true, name: "Calibri", size: 10.5 } }, priority: cfp() });
  } catch { /* cosmetic */ }

  // Executive insights — placed to the RIGHT of the KPI table (col F = tone, G–L = text), same
  // rows, so the two fill the horizontal band together instead of the KPI table leaving 8 blank cols.
  let insightRow = kpiHeader;
  if (data.insights.length > 0) {
    data.insights.slice(0, 12).forEach((insight) => {
      dash.setValue(insightRow, 6, insight.tone.toUpperCase()); dash.setStyle(insightRow, 6, textCell(true));
      dash.merge(insightRow, 7, insightRow, 12); dash.setValue(insightRow, 7, cleanText(insight.text)); dash.setStyle(insightRow, 7, textCell(false));
      insightRow += 1;
    });
  } else {
    dash.merge(insightRow, 6, insightRow, 12); dash.setValue(insightRow, 6, "No insights for the current selection."); dash.setStyle(insightRow, 6, textCell(false));
    insightRow += 1;
  }
  const bandBottom = Math.max(kpiLast, insightRow - 1);

  // ── Native charts, 3 ACROSS (4 cols each: A–D, E–H, I–L) — fills the width and roughly halves
  //    the vertical scroll vs the old 2-wide stack. Charts are collected then placed in a grid. ──
  const chartTop = bandBottom + 2;
  const q = (name: string) => `'${name.replace(/'/g, "''")}'`;
  const topN = (r: SheetRanges, n: number) => Math.min(n, Math.max(1, r.count));
  const seriesFor = (r: SheetRanges, count: number) => ({
    values: `${q(r.sheetName)}!$${colLetter(r.valueCol)}$${r.firstRow}:$${colLetter(r.valueCol)}$${r.firstRow + count - 1}`,
    categories: `${q(r.sheetName)}!$${colLetter(r.nameCol)}$${r.firstRow}:$${colLetter(r.nameCol)}$${r.firstRow + count - 1}`,
  });
  // Bridge + channel helper series go on the HIDDEN Data sheet (far columns) — never on the
  // Dashboard, so their raw numbers can't appear beside the charts. Trend helpers were written
  // there by buildDataSheet.
  const dataSheet = ctx.wb.getSheet("Data");
  const bridgeMovers = ctx.mom
    ? [...ctx.mom.contribution.products].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8)
    : [];
  if (dataSheet) {
    bridgeMovers.forEach((m, i) => { dataSheet.setValue(2 + i, BRIDGE_LBL_COL, cleanText(m.label)); dataSheet.setValue(2 + i, BRIDGE_VAL_COL, m.delta); });
    data.channelMix.forEach((c, i) => { dataSheet.setValue(2 + i, CHMIX_LBL_COL, cleanText(c.name)); dataSheet.setValue(2 + i, CHMIX_VAL_COL, c.value); });
  }
  const brL = colLetter(BRIDGE_LBL_COL), brV = colLetter(BRIDGE_VAL_COL);
  const chmL = colLetter(CHMIX_LBL_COL), chmV = colLetter(CHMIX_VAL_COL);
  const bridgeN = bridgeMovers.length, chmN = data.channelMix.length;

  type ChartSpec = Omit<Parameters<Worksheet["addChart"]>[0], "from" | "to">;
  const specs: ChartSpec[] = [];
  // No data labels — at the 3-across size they collide; the exact figures live in the breakdown sheets.
  const base = { legend: false as const, varyColors: true, roundedCorners: true, chartFill: "white" as const };
  if (ranges.products.count > 0) specs.push({ type: "bar", title: "Top Products by Value", series: [{ name: "Value", color: ORANGE, ...seriesFor(ranges.products, topN(ranges.products, 10)) }], colorPalette: "orange", ...base });
  if (ranges.regions.count > 0) specs.push({ type: "column", title: "Value by Region", series: [{ name: "Value", color: ORANGE_DEEP, ...seriesFor(ranges.regions, topN(ranges.regions, 10)) }], colorPalette: "orange", ...base });
  if (ranges.distributors.count > 0) specs.push({ type: "column", title: "Value by Distributor (top 8)", series: [{ name: "Value", color: BLUE, ...seriesFor(ranges.distributors, topN(ranges.distributors, 8)) }], colorPalette: "blueWarm", ...base });
  if (data.trend.length > 0) {
    const lbl = colLetter(TREND_LBL_COL), val = colLetter(TREND_VAL_COL);
    // Straight line (roundedCorners:false) so the trend never smooth-overshoots below zero.
    specs.push({ type: "line", title: "6-Month Value Trend", series: [{ name: "Value", color: ORANGE, values: `Data!$${val}$2:$${val}$${1 + data.trend.length}`, categories: `Data!$${lbl}$2:$${lbl}$${1 + data.trend.length}` }], legend: false, varyColors: true, chartFill: "white", roundedCorners: false });
  }
  if (ranges.pareto.count > 0) specs.push({ type: "column", title: "Pareto — Top Products (80/20 base)", series: [{ name: "Value", color: ORANGE_DEEP, ...seriesFor(ranges.pareto, topN(ranges.pareto, 10)) }], colorPalette: "orange", ...base });
  if (bridgeN > 0) specs.push({ type: "column", title: "MoM Value Bridge (top movers)", series: [{ name: "Δ value", color: BLUE, values: `Data!$${brV}$2:$${brV}$${1 + bridgeN}`, categories: `Data!$${brL}$2:$${brL}$${1 + bridgeN}` }], colorPalette: "blueWarm", ...base });
  if (chmN > 0) specs.push({ type: "column", title: "Channel Mix — value by channel", series: [{ name: "Value", color: ORANGE, values: `Data!$${chmV}$2:$${chmV}$${1 + chmN}`, categories: `Data!$${chmL}$2:$${chmL}$${1 + chmN}` }], colorPalette: "orange", ...base });

  const CH_W = 4, CH_H = 15, CH_GAP = 1;
  specs.forEach((spec, i) => {
    const band = Math.floor(i / 3), col = i % 3;
    const fromCol = col * CH_W, fromRow = chartTop + band * (CH_H + CH_GAP);
    try { dash.addChart({ ...spec, from: { col: fromCol, row: fromRow }, to: { col: fromCol + CH_W - 1, row: fromRow + CH_H } }); } catch { /* chart best-effort */ }
  });
  const chartBottom = chartTop + Math.max(1, Math.ceil(specs.length / 3)) * (CH_H + CH_GAP);

  // Contents panel — clickable HYPERLINK() index of every visible sheet.
  const contents: { name: string; desc: string }[] = [
    { name: "MoM Movers", desc: "Month-over-month gainers, decliners, new & lost." },
    { name: "Trend", desc: "6-month value and units trajectory." },
    { name: "Region x Product", desc: "Heat-mapped value matrix (top 20 products)." },
    { name: "Pareto ABC", desc: "80/20 product ranking with ABC classes." },
    { name: "Distributor x Product", desc: "Value matrix across distributors." },
    { name: "Product x Month", desc: "Product trajectory across the selected months." },
    { name: "Region x Distributor", desc: "Which distributor sells where (heat matrix)." },
    { name: "Line x Region", desc: "Product-line strength across regions (heat matrix)." },
    { name: "Area x Product", desc: "Area × product value (heat matrix)." },
    { name: "Region Pareto", desc: "Each region's own 80/20 (collapsible)." },
    { name: "Growth Contribution", desc: "Who moved the month-over-month number." },
    { name: "Outliers", desc: "Statistically unusual products and regions." },
    { name: "Coverage", desc: "Region × Line traffic-lights and coverage depth." },
    { name: "Region Drill", desc: "Region → product drill-down (collapsible)." },
    { name: "Distributors", desc: "Distributor totals with reach columns." },
    { name: "Regions", desc: "Region totals with share." },
    { name: "Areas", desc: "Area totals with coverage status." },
    { name: "Products", desc: "Product totals with share." },
    { name: "Lines", desc: "Product-line totals." },
    { name: "Top Customers", desc: "Highest-value customers in scope." },
    { name: "Bricks", desc: "Top and bottom bricks." },
    { name: "White-space", desc: "Areas with zero distributor sales." },
    { name: "Report Info", desc: "Provenance, scope and value semantics." },
  ];
  // Contents index in TWO columns (left block cols A–F, right block cols G–L) so 23 links occupy
  // ~12 rows instead of 23 — right below the chart grid, not far down an empty column.
  const cStart = chartBottom + 1;
  dash.merge(cStart, 1, cStart, 12); dash.setValue(cStart, 1, "CONTENTS");
  dash.setStyle(cStart, 1, { font: { bold: true, size: 12, color: ORANGE, name: "Calibri" }, fill: fill(SLATE_900), alignment: { vertical: "center", indent: 1 } });
  for (let c = 2; c <= 12; c += 1) dash.setStyle(cStart, c, { fill: fill(SLATE_900) });
  const half = Math.ceil(contents.length / 2);
  contents.forEach((s, i) => {
    const rightCol = i >= half;
    const r = cStart + 1 + (i % half);
    const nameCol = rightCol ? 7 : 1;
    try { dash.setFormula(r, nameCol, `HYPERLINK("#'${s.name.replace(/'/g, "''")}'!A1","${esc(s.name)}")`); }
    catch { dash.setValue(r, nameCol, s.name); }
    dash.setStyle(r, nameCol, { font: { color: BLUE, underline: "single", name: "Calibri", size: 10.5, bold: true }, alignment: { vertical: "center", indent: 1 } });
    dash.merge(r, nameCol + 1, r, nameCol + 5); dash.setValue(r, nameCol + 1, s.desc);
    dash.setStyle(r, nameCol + 1, { font: { color: INK, size: 9.5, name: "Calibri" }, alignment: { vertical: "center", indent: 1 } });
  });

  for (let c = 1; c <= 12; c += 1) dash.setColumnWidth(c, 12);
  dash.setColumnWidth(1, 24); dash.setColumnWidth(7, 24);
  applyPrintSetup(dash, "Source of Sales BI — Dashboard", ctx.generatedAt, 12, cStart + half + 1);
}

// ── main entry point ──────────────────────────────────────────────────────────────
export type SosBiWorkbookInput = {
  data: SosDashboardData;
  generatedBy: string;
  /** Preformatted, e.g. "2026-07-02 14:30 UTC". */
  generatedAt: string;
  /** Human-readable applied-filter summary for the cover + Report Info sheets. */
  filterSummary: string;
};

export async function buildSosBiWorkbook(input: SosBiWorkbookInput): Promise<Buffer> {
  const { data, generatedBy, generatedAt, filterSummary } = input;
  const leafRows = data.detailRows ?? [];
  const mom = data.momComparison ?? null;
  const priorPeriod = mom?.priorPeriod ?? null;

  // Period label reflects the full selection: one month → "2026-06"; several →
  // "3 months (2026-06 … 2026-04)". momComparison is null for multi-month views.
  const selected = data.selectedPeriods ?? (data.period ? [data.period] : []);
  const period =
    selected.length <= 1
      ? data.period ?? "—"
      : `${selected.length} months (${selected[0]} … ${selected[selected.length - 1]})`;
  const subtitle = `${period}${priorPeriod ? ` vs ${priorPeriod}` : ""} · ${filterSummary} · Generated ${generatedAt} by ${cleanText(generatedBy)}`;

  const wb = new Workbook();
  wb.calcSettings = { calcMode: "auto", fullCalcOnLoad: true };

  const dash = wb.addSheet("Dashboard"); // created first (leftmost), populated last
  const last = buildDataSheet(wb, leafRows, data.trend);
  const ctx: Ctx = { wb, data, subtitle, period, priorPeriod, generatedAt, last, hasLeaf: leafRows.length > 0, mom };

  // MoM Δ% lookup maps (plain payload numbers — the prior month is not in the Data grain).
  const momPctByCode = (movers: SosMoverRow[] | undefined): Map<string, number> => {
    const map = new Map<string, number>();
    for (const m of movers ?? []) map.set(m.code.toUpperCase(), m.deltaPct);
    return map;
  };
  const productMomPct = momPctByCode(mom ? [...mom.movers.products.gainers, ...mom.movers.products.decliners] : undefined);
  const regionMomPct = momPctByCode(mom ? [...mom.movers.regions.gainers, ...mom.movers.regions.decliners] : undefined);
  const distributorMomPct = momPctByCode(mom ? [...mom.movers.distributors.gainers, ...mom.movers.distributors.decliners] : undefined);

  const tree = buildRegionTree(leafRows);
  const months = [...(data.selectedPeriods ?? [])].sort();

  buildMomMovers(ctx);
  buildTrend(ctx);
  buildHeatMatrix(ctx, {
    sheetName: "Region x Product",
    title: "Region × Product Value Matrix (top 20 products)",
    rowHeader: "Region",
    rows: data.byRegion.map((r) => ({ code: r.code, label: r.label, total: r.value })),
    cols: data.byProduct.slice(0, 20).map((p) => ({ code: p.code, label: p.label })),
    rowCrit: "RegionCode", colCrit: "ProductCode",
  });
  const pareto = buildParetoAbc(ctx);
  buildHeatMatrix(ctx, {
    sheetName: "Distributor x Product",
    title: "Distributor × Product Value Matrix (top 20 products)",
    rowHeader: "Distributor",
    rows: data.byDistributor.map((r) => ({ code: r.code, label: r.label, total: r.value })),
    cols: data.byProduct.slice(0, 20).map((p) => ({ code: p.code, label: p.label })),
    rowCrit: "DistCode", colCrit: "ProductCode",
  });
  buildHeatMatrix(ctx, {
    sheetName: "Product x Month",
    title: `Product × Month Value Matrix (${months.length} month${months.length === 1 ? "" : "s"}, top 25 products)`,
    rowHeader: "Product",
    rows: data.byProduct.slice(0, 25).map((p) => ({ code: p.code, label: p.label, total: p.value })),
    cols: months.map((m) => ({ code: m, label: m })),
    rowCrit: "ProductCode", colCrit: "Period",
  });
  // Additional heat matrices (same loved rotated-header design) across more dimension pairs.
  buildHeatMatrix(ctx, {
    sheetName: "Region x Distributor",
    title: "Region × Distributor Value Matrix",
    rowHeader: "Region",
    rows: data.byRegion.map((r) => ({ code: r.code, label: r.label, total: r.value })),
    cols: data.byDistributor.map((db) => ({ code: db.code, label: db.label })),
    rowCrit: "RegionCode", colCrit: "DistCode",
  });
  buildHeatMatrix(ctx, {
    sheetName: "Line x Region",
    title: "Line × Region Value Matrix",
    rowHeader: "Product line",
    rows: data.byLine.map((l) => ({ code: l.code, label: l.label, total: l.value })),
    cols: data.byRegion.map((r) => ({ code: r.code, label: r.label })),
    rowCrit: "Line", colCrit: "RegionCode",
  });
  buildHeatMatrix(ctx, {
    sheetName: "Area x Product",
    title: "Area × Product Value Matrix (top 20 areas × top 15 products)",
    rowHeader: "Area",
    rows: data.byArea.slice(0, 20).map((a) => ({ code: a.code, label: a.label, total: a.value })),
    cols: data.byProduct.slice(0, 15).map((p) => ({ code: p.code, label: p.label })),
    rowCrit: "AreaCode", colCrit: "ProductCode",
  });
  buildRegionPareto(ctx, tree);
  buildGrowthContribution(ctx);
  buildOutliers(ctx);
  buildCoverage(ctx);
  buildRegionDrill(ctx, tree);
  const distributors = buildDistributors(ctx, distributorMomPct);
  const regions = buildBreakdown(ctx, { sheetName: "Regions", title: "By Region", dimLabel: "Region", critKey: "RegionCode", dims: data.byRegion, momPct: regionMomPct });
  buildAreas(ctx);
  const products = buildBreakdown(ctx, { sheetName: "Products", title: "By Product", dimLabel: "Product", critKey: "ProductCode", dims: data.byProduct, momPct: productMomPct });
  buildBreakdown(ctx, { sheetName: "Lines", title: "By Line", dimLabel: "Line", critKey: "Line", dims: data.byLine, momPct: new Map() });
  buildTopCustomers(ctx);
  buildBricks(ctx);
  buildWhiteSpace(ctx);
  buildReportInfo(ctx, generatedBy, filterSummary, leafRows.length);

  buildDashboardCover(ctx, dash, { products, regions, distributors, pareto });
  wb.setActiveSheet("Dashboard");

  const b64 = await wb.buildBase64();
  return Buffer.from(b64, "base64");
}
