/**
 * The rep effectiveness review as a workbook — the layout the owner accepted on Ebtissam Alaa's case
 * (25 Nov 2026), drawn from `model.ts`. Eight sheets, in the order the managers' questions come:
 *
 *   Answers · KPIs vs target · Sales vs target · Area history · Customers per product ·
 *   Pharmacy by month · Where the growth came from · Customer list
 *
 * The rep's own months wear an amber head and a pale amber column on every month grid, so her time and
 * the area's history before her read apart at a glance. "Customer list" is a real Excel table, one row
 * per pharmacy, month and product, so it pivots.
 *
 * Units are printed per product only; every total across products is value (units of different
 * products are never added).
 */

import ExcelJS from "exceljs";

import {
  monthLong,
  monthShort,
  pctOf,
  type EffKpiFigures,
  type EffScoreRow,
  type RepEffectivenessReport,
} from "@/lib/sales/rep-effectiveness/model";

export const REP_EFFECTIVENESS_SHEETS = [
  "Scorecard",
  "KPIs vs target",
  "Sales vs target",
  "Area history",
  "Customers per product",
  "Pharmacy by month",
  "Where the growth came from",
  "Customer list",
] as const;

const NAVY = "0A527D";
const BLUE = "0A6BA6";
const MUTED = "5A6B7C";
const GRID = "B9C7D4";
const INK = "1A1A1A";
const WHITE = "FFFFFF";
const AMBER = "B4530A";
const AMBER_PALE = "FFF4E5";
const ZEBRA = "F2F5F8";
const BOUGHT = "E3EDF5";
const GREEN = "1E7B34";
const RED = "B3261E";
const DASH = "–";
const MONEY = `#,##0;-#,##0;"${DASH}"`;
const UNITS = `#,##0;-#,##0;"${DASH}"`;

type Cell = ExcelJS.Cell;
type Value = string | number | null;

const argb = (hex: string) => ({ argb: `FF${hex}` });
const thin = { style: "thin" as const, color: argb(GRID) };
const BOX: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
const RULE_TOP: Partial<ExcelJS.Borders> = { top: { style: "medium", color: argb(NAVY) }, left: thin, bottom: thin, right: thin };
const CENTRE: Partial<ExcelJS.Alignment> = { horizontal: "center", vertical: "middle", wrapText: true };
const LEFT: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "middle", wrapText: true };
const TOP_LEFT: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "top", wrapText: true };

function fill(cell: Cell, hex: string): void {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(hex) };
}
function font(cell: Cell, o: { bold?: boolean; size?: number; color?: string } = {}): void {
  cell.font = { name: "Calibri", size: o.size ?? 10.5, bold: o.bold, color: argb(o.color ?? INK) };
}
function put(
  sheet: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: Value,
  o: { align?: Partial<ExcelJS.Alignment>; fmt?: string; bold?: boolean; color?: string; size?: number; bg?: string | null } = {},
): Cell {
  const cell = sheet.getCell(row, col);
  cell.value = value == null ? DASH : value;
  cell.border = BOX;
  cell.alignment = o.align ?? CENTRE;
  if (o.fmt && typeof value === "number") cell.numFmt = o.fmt;
  font(cell, { bold: o.bold, color: value == null ? MUTED : o.color, size: o.size });
  if (o.bg) fill(cell, o.bg);
  return cell;
}
function head(sheet: ExcelJS.Worksheet, row: number, col: number, value: string, bg = NAVY): Cell {
  const cell = put(sheet, row, col, value, { bold: true, color: WHITE, size: 9.5 });
  fill(cell, bg);
  return cell;
}
function pct(sheet: ExcelJS.Worksheet, row: number, col: number, value: number | null, o: { bg?: string | null; good?: number } = {}): Cell {
  const cell = put(sheet, row, col, value == null ? null : value / 100, { fmt: "0%", bold: value != null, bg: o.bg });
  if (value != null) font(cell, { bold: true, color: value >= (o.good ?? 100) ? GREEN : value < 50 ? RED : INK });
  return cell;
}
function banner(sheet: ExcelJS.Worksheet, report: RepEffectivenessReport, titleText: string, sub: string, lastCol: number): number {
  const t = sheet.getCell(1, 1);
  t.value = titleText;
  font(t, { bold: true, size: 15, color: NAVY });
  sheet.mergeCells(1, 1, 1, lastCol);
  const who = sheet.getCell(2, 1);
  who.value = `${report.rep.name} · ${report.rep.jobTitle} · ${report.rep.line} · ${report.rep.areaName}`;
  font(who, { bold: true, size: 10.5, color: BLUE });
  sheet.mergeCells(2, 1, 2, lastCol);
  const s = sheet.getCell(3, 1);
  s.value = sub;
  font(s, { size: 9, color: MUTED });
  s.alignment = TOP_LEFT;
  sheet.mergeCells(3, 1, 3, lastCol);
  sheet.getRow(3).height = 30;
  for (let c = 1; c <= lastCol; c += 1) sheet.getCell(4, c).border = { top: { style: "medium", color: argb(NAVY) } };
  return 5;
}
function section(sheet: ExcelJS.Worksheet, row: number, text: string, lastCol: number): number {
  const cell = sheet.getCell(row, 1);
  cell.value = text.toUpperCase();
  font(cell, { bold: true, size: 9.5, color: NAVY });
  sheet.mergeCells(row, 1, row, lastCol);
  for (let c = 1; c <= lastCol; c += 1) sheet.getCell(row, c).border = { bottom: { style: "thin", color: argb(GRID) } };
  return row + 1;
}
function widths(sheet: ExcelJS.Worksheet, values: number[]): void {
  values.forEach((w, i) => (sheet.getColumn(i + 1).width = w));
}
function print(sheet: ExcelJS.Worksheet, tall: number | undefined = 1): void {
  sheet.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: tall, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  sheet.views = [{ showGridLines: false }];
}

const isRep = (report: RepEffectivenessReport, month: string) => report.repMonths.includes(month);
const monthHead = (report: RepEffectivenessReport, month: string) => (isRep(report, month) ? AMBER : NAVY);
const monthBg = (report: RepEffectivenessReport, month: string, zebra: boolean) => (isRep(report, month) ? AMBER_PALE : zebra ? ZEBRA : null);

function kpiCells(sheet: ExcelJS.Worksheet, row: number, startCol: number, f: EffKpiFigures | null, bg: string | null): void {
  if (!f) {
    for (let c = 0; c < 7; c += 1) put(sheet, row, startCol + c, null, { bg });
    return;
  }
  pct(sheet, row, startCol, f.coveragePct, { bg, good: 95 });
  pct(sheet, row, startCol + 1, f.frequencyPct, { bg });
  put(sheet, row, startCol + 2, f.amPerDay, { fmt: "0.0", bg });
  pct(sheet, row, startCol + 3, f.amAttainmentPct, { bg });
  put(sheet, row, startCol + 4, f.pmPerDay, { fmt: "0.0", bg });
  pct(sheet, row, startCol + 5, f.pmAttainmentPct, { bg });
  if (f.justStarted) put(sheet, row, startCol + 6, "Just started", { bg, color: MUTED, size: 9 });
  else pct(sheet, row, startCol + 6, f.overallPct, { bg });
}

export async function buildRepEffectivenessWorkbook(report: RepEffectivenessReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce";
  wb.created = new Date(report.generatedAt);
  const generated = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }).format(new Date(report.generatedAt));
  const span = report.months.length ? `${monthLong(report.months[0])} to ${monthLong(report.months[report.months.length - 1])}` : "no published month";

  // ── 1. Scorecard — numbers only (owner, 25 Nov 2026: "I don't need all this text. I need numbers") ──
  {
    const ws = wb.addWorksheet("Scorecard");
    const sc = report.scorecard;
    const W = 2 + Math.max(sc.months.length, sc.kpiMonths.length);
    let r = banner(ws, report, "Effectiveness review", `${span} · read ${generated}, Cairo time`, W);
    const facts: [string, string][] = [
      ["Area", `${report.rep.areaName}${report.rep.regionName ? ` · ${report.rep.regionName}` : ""}`],
      ["Manager", report.rep.managerName ?? "Not recorded"],
      ["Hiring date", report.rep.hireDate ?? "Not recorded"],
    ];
    for (const [k, v] of facts) {
      put(ws, r, 1, k, { align: LEFT, bold: true, color: BLUE, size: 9 });
      ws.mergeCells(r, 2, r, W);
      put(ws, r, 2, v, { align: LEFT });
      r += 1;
    }
    const grid = (title: string, rows: EffScoreRow[], months: string[], targetHead: string) => {
      r += 1;
      r = section(ws, r, title, W);
      head(ws, r, 1, "");
      months.forEach((m, i) => head(ws, r, i + 2, monthShort(m), monthHead(report, m)));
      head(ws, r, months.length + 2, targetHead);
      r += 1;
      rows.forEach((row, i) => {
        put(ws, r, 1, row.label, { align: LEFT, bold: row.strong, color: row.strong ? NAVY : INK, bg: i % 2 ? ZEBRA : null });
        months.forEach((m, j) => {
          const v = row.values[m] ?? null;
          const bg = monthBg(report, m, i % 2 === 1);
          if (row.kind === "pct") pct(ws, r, j + 2, v, { bg });
          else put(ws, r, j + 2, v, { fmt: row.kind === "rate" ? "0.0" : MONEY, bold: row.strong, bg });
        });
        const t = row.target ?? null;
        put(ws, r, months.length + 2, t == null ? "" : row.kind === "pct" ? t / 100 : t, { fmt: row.kind === "pct" ? "0%" : row.kind === "rate" ? "0.0" : MONEY, color: MUTED, size: 9 });
        r += 1;
      });
    };
    grid("The area, month by month", sc.closing, sc.months, "On the map");
    grid("KPIs", sc.kpi, sc.kpiMonths, "Target");
    widths(ws, [34, ...Array.from({ length: W - 1 }, () => 14)]);
    print(ws);
  }

  // ── 2. KPIs vs target ──────────────────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet("KPIs vs target");
    const W = 9;
    let r = banner(ws, report, "KPIs against their targets", span, W);
    const heads = ["Month", "Who", "Coverage", "Frequency", "Account visits a day", "Account visits vs 2", "Doctor visits a day", "Doctor visits vs 10", "Overall"];
    heads.forEach((h, i) => head(ws, r, i + 1, h));
    ws.getRow(r).height = 30;
    r += 1;
    put(ws, r, 1, "Target", { bold: true, color: MUTED, size: 9 });
    ["", "95%", "100%", "2.0", "100%", "10.0", "100%", "100%"].forEach((t, i) => put(ws, r, i + 2, t || DASH, { color: MUTED, size: 9 }));
    r += 1;
    for (const k of report.kpis) {
      const label = `${monthLong(k.month)}${k.toDate ? " (to date)" : ""}`;
      put(ws, r, 1, label, { bold: true, color: NAVY, bg: AMBER_PALE, align: LEFT });
      put(ws, r, 2, k.unread ? "Board could not be read" : report.rep.name, { bold: true, bg: AMBER_PALE, align: LEFT });
      kpiCells(ws, r, 3, k.unread ? null : k.rep, AMBER_PALE);
      r += 1;
      k.colleagues.forEach((c, i) => {
        const bg = i % 2 ? ZEBRA : null;
        put(ws, r, 1, "", { bg });
        put(ws, r, 2, `${c.name}${c.area ? ` · ${c.area}` : ""}`, { align: LEFT, size: 9.5, bg });
        kpiCells(ws, r, 3, c.figures, bg);
        r += 1;
      });
    }
    if (report.kpis.length === 0) {
      ws.mergeCells(r, 1, r, W);
      put(ws, r, 1, "No KPI month falls on or after the rep's hiring date.", { align: LEFT, color: MUTED });
    }
    widths(ws, [20, 34, 11, 11, 12, 12, 12, 12, 11]);
    print(ws, 0);
  }

  // ── 3. Sales vs target ─────────────────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet("Sales vs target");
    const W = 9;
    let r = banner(ws, report, "Sales against target, product by product", span, W);
    ["Month", "Product", "Units sold", "Units target", "Units", "Value sold (EGP)", "Value target (EGP)", "Value", "Seat held by"].forEach((h, i) => head(ws, r, i + 1, h));
    ws.getRow(r).height = 28;
    r += 1;
    for (const s of [...report.sales].reverse()) {
      const bg = isRep(report, s.month) ? AMBER_PALE : null;
      for (const p of report.products) {
        const cell = report.productSales[p.code]?.[s.month];
        if (!cell) continue;
        put(ws, r, 1, monthLong(s.month), { align: LEFT, bg, size: 9.5 });
        put(ws, r, 2, p.name, { align: LEFT, bg });
        put(ws, r, 3, cell.actualUnits, { fmt: UNITS, bg });
        put(ws, r, 4, cell.targetUnits, { fmt: UNITS, bg });
        pct(ws, r, 5, cell.targetUnits ? pctOf(cell.actualUnits, cell.targetUnits) : null, { bg });
        put(ws, r, 6, cell.actualValue, { fmt: MONEY, bg });
        put(ws, r, 7, cell.targetValue, { fmt: MONEY, bg });
        pct(ws, r, 8, cell.targetValue ? pctOf(cell.actualValue, cell.targetValue) : null, { bg });
        put(ws, r, 9, s.holder ?? "Not recorded", { align: LEFT, size: 9, color: MUTED, bg });
        r += 1;
      }
      for (let c = 1; c <= W; c += 1) ws.getCell(r, c).border = RULE_TOP;
      put(ws, r, 1, monthLong(s.month), { align: LEFT, bold: true, color: NAVY });
      ws.getCell(r, 1).border = RULE_TOP;
      put(ws, r, 2, "All products (value)", { align: LEFT, bold: true }).border = RULE_TOP;
      for (const c of [3, 4, 5]) put(ws, r, c, "", {}).border = RULE_TOP;
      put(ws, r, 6, s.actualValue, { fmt: MONEY, bold: true }).border = RULE_TOP;
      put(ws, r, 7, s.targetValue, { fmt: MONEY, bold: true }).border = RULE_TOP;
      pct(ws, r, 8, s.achievementPct).border = RULE_TOP;
      put(ws, r, 9, s.achievementWithoutDirectPct != null ? `${s.achievementWithoutDirectPct}% without direct orders` : "", { size: 9, color: MUTED }).border = RULE_TOP;
      r += 2;
    }
    widths(ws, [16, 24, 11, 11, 9, 15, 15, 9, 26]);
    ws.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];
    print(ws, 0);
  }

  // ── 4. Area history ────────────────────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet("Area history");
    const W = 11;
    let r = banner(ws, report, "The area, month by month", span, W);
    ["Month", "Seat held by", "Sales", "Target", "Achievement", "Direct orders", "Without direct orders", "Pharmacy sales", "Wholesaler share", "Other", "Pharmacies buying"].forEach((h, i) => head(ws, r, i + 1, h));
    ws.getRow(r).height = 30;
    r += 1;
    report.sales.forEach((s, i) => {
      const bg = monthBg(report, s.month, i % 2 === 1);
      const src = report.sources[s.month];
      put(ws, r, 1, monthLong(s.month), { align: LEFT, bold: true, color: isRep(report, s.month) ? AMBER : NAVY, bg });
      put(ws, r, 2, s.holder ?? "Not recorded", { align: LEFT, bg });
      put(ws, r, 3, s.actualValue, { fmt: MONEY, bold: true, bg });
      put(ws, r, 4, s.targetValue ?? "No target set", { fmt: MONEY, bg, color: s.targetValue == null ? MUTED : undefined, size: s.targetValue == null ? 9 : undefined });
      pct(ws, r, 5, s.achievementPct, { bg });
      put(ws, r, 6, s.directValue, { fmt: MONEY, bg });
      pct(ws, r, 7, s.achievementWithoutDirectPct, { bg });
      put(ws, r, 8, src?.pharmacy ?? null, { fmt: MONEY, bg });
      put(ws, r, 9, src?.wholesalerShare ?? null, { fmt: MONEY, bg });
      put(ws, r, 10, src?.other ?? null, { fmt: MONEY, bg });
      put(ws, r, 11, s.pharmaciesBuying, { bold: true, color: NAVY, bg });
      r += 1;
    });
    widths(ws, [16, 24, 12, 13, 12, 12, 12, 13, 13, 11, 12]);
    print(ws);
  }

  // ── 5. Customers per product, and by brick ─────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet("Customers per product");
    const n = report.months.length;
    const W = n + 2;
    let r = banner(
      ws,
      report,
      "Customers per product per month",
      report.universe.total != null ? `${span} · ${report.universe.total.toLocaleString("en-US")} customers on the map` : span,
      W,
    );
    head(ws, r, 1, "Product");
    report.months.forEach((m, j) => head(ws, r, 2 + j, monthShort(m), monthHead(report, m)));
    head(ws, r, W, "Rep's months, a month");
    r += 1;
    const avg = (code: string) => {
      if (!report.repMonths.length) return null;
      return Math.round((report.repMonths.reduce((sum, m) => sum + (report.customers[code]?.[m] ?? 0), 0) / report.repMonths.length) * 10) / 10;
    };
    report.products.forEach((p, i) => {
      put(ws, r, 1, p.name, { align: LEFT, bold: true, color: NAVY, bg: i % 2 ? ZEBRA : null });
      report.months.forEach((m, j) => {
        const v = report.customers[p.code]?.[m] ?? 0;
        put(ws, r, 2 + j, v || null, { bold: isRep(report, m) && v > 0, bg: monthBg(report, m, i % 2 === 1) });
      });
      put(ws, r, W, avg(p.code), { fmt: "0.0", bold: true, bg: i % 2 ? ZEBRA : null });
      r += 1;
    });
    put(ws, r, 1, "Any product", { align: LEFT, bold: true }).border = RULE_TOP;
    report.sales.forEach((s, j) => (put(ws, r, 2 + j, s.pharmaciesBuying, { bold: true, color: NAVY, bg: monthBg(report, s.month, false) }).border = RULE_TOP));
    put(ws, r, W, report.repMonths.length ? Math.round((report.sales.filter((s) => s.isRepMonth).reduce((a, s) => a + s.pharmaciesBuying, 0) / report.repMonths.length) * 10) / 10 : null, { fmt: "0.0", bold: true }).border = RULE_TOP;
    r += 2;
    r = section(ws, r, "Pharmacies buying any product, by brick", W);
    head(ws, r, 1, "Brick");
    report.months.forEach((m, j) => head(ws, r, 2 + j, monthShort(m), monthHead(report, m)));
    head(ws, r, W, "Customers on the map");
    r += 1;
    report.bricks.forEach((b, i) => {
      put(ws, r, 1, b.name, { align: LEFT, bold: true, color: NAVY, bg: i % 2 ? ZEBRA : null });
      report.months.forEach((m, j) => put(ws, r, 2 + j, b.months[m] || null, { bg: monthBg(report, m, i % 2 === 1) }));
      put(ws, r, W, b.onMap, { fmt: "#,##0", color: MUTED, bg: i % 2 ? ZEBRA : null });
      r += 1;
    });
    widths(ws, [26, ...report.months.map(() => 9), 14]);
    print(ws);
  }

  // ── 6. Pharmacy by month ───────────────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet("Pharmacy by month");
    const n = report.months.length;
    const W = n + 4;
    const legend = report.products.map((p) => `${p.tag} ${p.name}`).join(" · ");
    let r = banner(ws, report, "Every pharmacy that bought, month by month", legend, W);
    head(ws, r, 1, "Pharmacy");
    head(ws, r, 2, "Brick");
    report.months.forEach((m, j) => head(ws, r, 3 + j, monthShort(m), monthHead(report, m)));
    head(ws, r, n + 3, "Months bought");
    head(ws, r, n + 4, "New in the rep's time");
    ws.getRow(r).height = 28;
    const headRow = r;
    r += 1;
    report.pharmacies.forEach((p, i) => {
      const bg = i % 2 ? ZEBRA : null;
      put(ws, r, 1, p.name, { align: { horizontal: "right", vertical: "middle", wrapText: true }, size: 9.5, bg });
      put(ws, r, 2, p.brickName, { align: { horizontal: "right", vertical: "middle", wrapText: true }, size: 9, color: MUTED, bg });
      report.months.forEach((m, j) => {
        const got = p.months[m];
        put(ws, r, 3 + j, got ? got.join(" ") : "", { size: 9, bold: Boolean(got), color: NAVY, bg: isRep(report, m) ? AMBER_PALE : got ? BOUGHT : bg });
      });
      put(ws, r, n + 3, p.monthsBought, { bold: true, color: NAVY, bg });
      put(ws, r, n + 4, p.newInRepTime ? "New" : "", { size: 9, color: AMBER, bold: true, bg });
      r += 1;
    });
    put(ws, r, 1, "Pharmacies buying that month", { align: LEFT, bold: true }).border = RULE_TOP;
    put(ws, r, 2, "", {}).border = RULE_TOP;
    report.sales.forEach((s, j) => (put(ws, r, 3 + j, s.pharmaciesBuying, { bold: true, color: NAVY }).border = RULE_TOP));
    put(ws, r, n + 3, report.pharmacies.length, { bold: true, color: NAVY }).border = RULE_TOP;
    put(ws, r, n + 4, report.pharmacies.filter((p) => p.newInRepTime).length, { bold: true, color: AMBER }).border = RULE_TOP;
    widths(ws, [34, 16, ...report.months.map(() => 8), 10, 11]);
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: headRow, showGridLines: false }];
    print(ws, 0);
  }

  // ── 7. Where the growth came from ──────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet("Where the growth came from");
    const W = 4;
    let r = banner(ws, report, "Where the growth came from", span, W);
    const g = report.growth;
    if (!g) {
      ws.mergeCells(r, 1, r, W);
      put(ws, r, 1, "Two published months are needed to show a change.", { align: LEFT, color: MUTED });
    } else {
      ["", "Step", "EGP", "Share of the change"].forEach((h, i) => head(ws, r, i + 1, h));
      r += 1;
      const total = g.end - g.start;
      put(ws, r, 1, "", {});
      put(ws, r, 2, `${monthLong(g.from)} closing`, { align: LEFT, bold: true });
      put(ws, r, 3, g.start, { fmt: MONEY, bold: true });
      put(ws, r, 4, "", {});
      r += 1;
      g.steps.forEach((s, i) => {
        put(ws, r, 1, s.change >= 0 ? "+" : "−", { bold: true, color: s.change >= 0 ? GREEN : RED, bg: i % 2 ? ZEBRA : null });
        put(ws, r, 2, s.label, { align: LEFT, bg: i % 2 ? ZEBRA : null });
        put(ws, r, 3, s.change, { fmt: MONEY, color: s.change >= 0 ? GREEN : RED, bg: i % 2 ? ZEBRA : null });
        pct(ws, r, 4, Math.abs(total) >= 1 ? pctOf(s.change, total) : null, { bg: i % 2 ? ZEBRA : null, good: 1000 });
        r += 1;
      });
      put(ws, r, 1, "", {}).border = RULE_TOP;
      put(ws, r, 2, `${monthLong(g.to)} closing`, { align: LEFT, bold: true }).border = RULE_TOP;
      put(ws, r, 3, g.end, { fmt: MONEY, bold: true }).border = RULE_TOP;
      put(ws, r, 4, "", {}).border = RULE_TOP;
    }
    widths(ws, [6, 44, 16, 16]);
    print(ws);
  }

  // ── 8. Customer list (a real table) ────────────────────────────────────────────────────────────
  {
    const ws = wb.addWorksheet("Customer list");
    const byTag = new Map(report.products.map((p) => [p.tag, p.name]));
    const rows: (string | number)[][] = [];
    for (const p of report.pharmacies) {
      for (const m of report.months) {
        for (const tag of p.months[m] ?? []) rows.push([monthLong(m), m, isRep(report, m) ? "Yes" : "No", p.name, p.brickName, byTag.get(tag) ?? tag, 1]);
      }
    }
    rows.sort((a, b) => String(b[1]).localeCompare(String(a[1])) || String(a[3]).localeCompare(String(b[3])));
    ws.addTable({
      name: "CustomerList",
      ref: "A1",
      headerRow: true,
      style: { theme: "TableStyleLight9", showRowStripes: true },
      columns: [
        { name: "Month", filterButton: true },
        { name: "Month key", filterButton: true },
        { name: "Rep's month", filterButton: true },
        { name: "Pharmacy", filterButton: true },
        { name: "Brick", filterButton: true },
        { name: "Product", filterButton: true },
        { name: "Bought", filterButton: true },
      ],
      rows: rows.length > 0 ? rows : [["", "", "", "No pharmacy bought in the published months", "", "", 0]],
    });
    widths(ws, [16, 11, 12, 38, 18, 22, 9]);
    ws.views = [{ state: "frozen", ySplit: 1 }];
    print(ws, 0);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
