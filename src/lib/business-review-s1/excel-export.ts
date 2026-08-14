// S1 Business Review — premium XLSX export. READ-ONLY: reads the bundled, verified
// datasets and writes a workbook. Styling follows the established Phoenix export
// identity (see src/lib/attendance/monthly-summary-export.ts): orange title band,
// slate column headers, hairline borders, banded achievement cells.
//
// Numbers are taken verbatim from the same datasets the dashboard renders, so the
// workbook can never drift from the screen. In particular:
//   - achievement is always the dataset's stored sum(sales)/sum(target), never
//     recomputed or averaged here;
//   - company doctors use the cross-line UNION (summing the per-line counts would
//     double-count doctors covered by two lines);
//   - lines with no CRM export show "N/A", never 0, for visit-derived columns.

import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
import {
  bandFor,
  getS1Company,
  loadS1Review,
  payoutPercentageFor,
  S1_LINES,
  S1_RESTATEMENT_NOTICE,
  type S1Line,
  type S1Review,
  type S1View,
} from "./service";
import type { AreaSummary, DmSummary, S1Company, S1Dataset } from "./types";

const ORANGE = "FFC2410C";
const SLATE = "FF0F172A";
const SOFT = "FFE2E8F0";
const HAIR = "FFF1F5F9";
const MUTED = "FF475569";
const ZEBRA = "FFF8FAFC";

/** Achievement banding — mirrors the dashboard's achColor() thresholds exactly. */
function achFill(ach: number | null): string | null {
  if (ach == null) return null;
  if (ach >= 100) return "FFD1FAE5"; // emerald
  if (ach >= 90) return "FFCCFBF1"; // teal
  if (ach >= 70) return "FFFEF3C7"; // amber
  if (ach >= 40) return "FFFFEDD5"; // orange
  return "FFFFE4E6"; // red
}
function achFont(ach: number | null): string {
  if (ach == null) return MUTED;
  if (ach >= 100) return "FF047857";
  if (ach >= 90) return "FF0F766E";
  if (ach >= 70) return "FFB45309";
  if (ach >= 40) return "FFC2410C";
  return "FFBE123C";
}

type Col = { label: string; width: number; kind?: "egp" | "pct" | "num" | "text" };

function titleBand(sheet: ExcelJS.Worksheet, ncols: number, title: string, subtitle: string, note?: string) {
  sheet.mergeCells(1, 1, 1, ncols);
  const t = sheet.getCell(1, 1);
  t.value = title;
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
  t.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 15 };
  t.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, ncols);
  const s = sheet.getCell(2, 1);
  s.value = subtitle;
  s.font = { color: { argb: MUTED }, italic: true, size: 10 };
  s.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(2).height = 18;

  if (note) {
    sheet.mergeCells(3, 1, 3, ncols);
    const n = sheet.getCell(3, 1);
    n.value = note;
    n.font = { bold: true, color: { argb: ORANGE }, italic: true, size: 9 };
    n.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    sheet.getRow(3).height = 16;
  }
}

function headerRow(sheet: ExcelJS.Worksheet, rowIdx: number, cols: Col[]) {
  const row = sheet.getRow(rowIdx);
  cols.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.value = c.label;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SLATE } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: SOFT } },
      left: { style: "thin", color: { argb: SOFT } },
      right: { style: "thin", color: { argb: SOFT } },
      bottom: { style: "thin", color: { argb: SOFT } },
    };
  });
  row.height = 28;
  cols.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.width;
  });
  sheet.views = [{ state: "frozen", ySplit: rowIdx }];
  sheet.autoFilter = {
    from: { row: rowIdx, column: 1 },
    to: { row: rowIdx, column: cols.length },
  };
}

/** Writes one body row, applying number formats, zebra striping and achievement bands.
 * `achCols` are 1-based column indexes holding an achievement % that should be banded. */
function bodyRow(
  sheet: ExcelJS.Worksheet,
  rowIdx: number,
  cols: Col[],
  values: (string | number | null)[],
  opts: { achCols?: number[]; bold?: boolean; zebra?: boolean } = {},
) {
  const row = sheet.getRow(rowIdx);
  cols.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    const v = values[i];
    cell.value = v === null || v === undefined ? "" : v;
    cell.font = { color: { argb: SLATE }, size: 10, bold: !!opts.bold };
    cell.alignment = { vertical: "middle", horizontal: c.kind && c.kind !== "text" ? "right" : "left" };
    cell.border = { bottom: { style: "thin", color: { argb: HAIR } } };
    if (c.kind === "egp") cell.numFmt = '#,##0;[Red]-#,##0';
    if (c.kind === "num") cell.numFmt = "#,##0.##";
    if (c.kind === "pct") cell.numFmt = '0.0"%"';
    if (opts.zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
  });
  for (const ci of opts.achCols ?? []) {
    const cell = row.getCell(ci);
    const raw = values[ci - 1];
    const ach = typeof raw === "number" ? raw : null;
    const fill = achFill(ach);
    if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.font = { bold: true, color: { argb: achFont(ach) }, size: 10 };
  }
  row.height = 18;
}

const naOr = (v: number, available: boolean): number | string => (available ? v : "N/A");
const pctOr = (v: number | null): number | string => (v == null ? "—" : v);

// ============================== COVER ==============================
function addCover(wb: ExcelJS.Workbook, company: S1Company, scopeLabel: string) {
  const sheet = wb.addWorksheet("Cover", { properties: { tabColor: { argb: ORANGE } } });
  titleBand(sheet, 4, "PHOENIX · S1 2026 BUSINESS REVIEW", `${company.meta.period} · ${scopeLabel}`);
  sheet.mergeCells(3, 1, 3, 4);
  const notice = sheet.getCell(3, 1);
  notice.value = S1_RESTATEMENT_NOTICE;
  notice.font = { bold: true, color: { argb: "FF92400E" }, size: 9, italic: true };
  notice.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
  notice.alignment = { wrapText: true, vertical: "middle" };
  sheet.getRow(3).height = 30;
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 26;
  sheet.getColumn(3).width = 26;
  sheet.getColumn(4).width = 46;

  const T = company.total;
  let r = 5;
  const kpi = (label: string, value: string | number, sub: string, kind?: Col["kind"], ach?: number | null) => {
    const l = sheet.getCell(r, 1);
    l.value = label;
    l.font = { bold: true, color: { argb: MUTED }, size: 9 };
    const v = sheet.getCell(r, 2);
    v.value = value;
    v.font = { bold: true, color: { argb: ach != null ? achFont(ach) : SLATE }, size: 13 };
    if (kind === "egp") v.numFmt = "#,##0";
    if (kind === "pct") v.numFmt = '0.0"%"';
    const s = sheet.getCell(r, 4);
    s.value = sub;
    s.font = { color: { argb: MUTED }, size: 9, italic: true };
    r += 1;
  };
  kpi("Company achievement", T.allProducts.ach ?? 0, "sum(sales) / sum(target) — never an average of line %s", "pct", T.allProducts.ach);
  kpi("Sales", T.allProducts.sales, "all products, all areas", "egp");
  kpi("Target", T.allProducts.target, "", "egp");
  kpi("Doctors reached", T.customersTotal, company.meta.doctorNote);
  kpi("Visits", T.visits, `${T.reps} reps · ${T.doubleVisits} double visits`);
  kpi("Marketing", T.marketingCost, "GM-approved only (committed spend)", "egp");
  kpi("Outstation expenses", T.outstationCost, "rejected claims excluded", "egp");
  kpi("Areas", T.areas, `${T.areasVacant} vacant (${Math.round((100 * T.areasVacant) / Math.max(1, T.areas))}%)`);

  r += 1;
  const h = sheet.getCell(r, 1);
  h.value = "How to read this workbook";
  h.font = { bold: true, color: { argb: ORANGE }, size: 11 };
  r += 1;
  const notes = [
    "Achievement is always all-products (include + exclude) as stored in the verified dataset.",
    "≥ 90% unlocks incentive per the locked 2026 scheme; payout % comes from that same curve.",
    "Vacant areas are never counted as earners and never listed as rep failures — they are a",
    "coverage gap, so they appear under 'Uncovered'. Their achievement is still shown unchanged.",
    "'N/A' means that line has no CRM visits export at all — it does not mean zero.",
    "Company doctor count is a true cross-line union, not the sum of the three lines.",
  ];
  for (const n of notes) {
    const c = sheet.getCell(r, 1);
    c.value = n;
    c.font = { color: { argb: SLATE }, size: 9 };
    sheet.mergeCells(r, 1, r, 4);
    r += 1;
  }

  r += 1;
  const g = sheet.getCell(r, 1);
  g.value = `Sources: ${company.meta.generatedFrom.join(" · ")}`;
  g.font = { color: { argb: MUTED }, size: 8, italic: true };
  sheet.mergeCells(r, 1, r, 4);
}

// ============================== COMPANY ==============================
function addCompanySheets(wb: ExcelJS.Workbook, review: S1Review, company: S1Company) {
  const T = company.total;

  // -- Line comparison --
  const lc: Col[] = [
    { label: "Line", width: 18 }, { label: "Achievement %", width: 14, kind: "pct" },
    { label: "Sales", width: 16, kind: "egp" }, { label: "Target", width: 16, kind: "egp" },
    { label: "Excl. vacant %", width: 14, kind: "pct" }, { label: "Marketing", width: 14, kind: "egp" },
    { label: "Expenses", width: 13, kind: "egp" }, { label: "Earners", width: 10, kind: "num" },
    { label: "Rep fails", width: 10, kind: "num" }, { label: "DM seats", width: 10, kind: "num" },
    { label: "Vacant seats", width: 12, kind: "num" }, { label: "Visits", width: 12, kind: "num" },
    { label: "Doctors", width: 11, kind: "num" },
  ];
  const s1 = wb.addWorksheet("Company · Lines", { properties: { tabColor: { argb: ORANGE } } });
  titleBand(s1, lc.length, "LINE COMPARISON", `${company.meta.period} · ranked by achievement`,
    "Company row is sum(sales)/sum(target) across all three lines — not an average of the line percentages.");
  headerRow(s1, 4, lc);
  let r = 5;
  company.lines.forEach((l, i) => {
    bodyRow(s1, r++, lc, [
      l.label, pctOr(l.allProducts.ach), l.allProducts.sales, l.allProducts.target,
      pctOr(l.exVacant.ach), l.marketingCost, l.outstationCost, l.earners, l.repFails,
      l.dms, l.dmsVacant,
      naOr(l.visits, l.visitsAvailable), naOr(l.customersTotal, l.visitsAvailable),
    ], { achCols: [2, 5], zebra: i % 2 === 1 });
  });
  bodyRow(s1, r, lc, [
    "COMPANY", pctOr(T.allProducts.ach), T.allProducts.sales, T.allProducts.target,
    pctOr(T.exVacant.ach), T.marketingCost, T.outstationCost,
    company.lines.reduce((s, l) => s + l.earners, 0),
    company.lines.reduce((s, l) => s + l.repFails, 0),
    company.lines.reduce((s, l) => s + l.dms, 0),
    company.lines.reduce((s, l) => s + l.dmsVacant, 0),
    T.visits, T.customersTotal,
  ], { achCols: [2, 5], bold: true });
  s1.getRow(r).eachCell((c) => {
    c.border = { top: { style: "medium", color: { argb: SLATE } }, bottom: { style: "thin", color: { argb: HAIR } } };
  });

  // -- Company DSM league --
  const dl: Col[] = [
    { label: "#", width: 5, kind: "num" }, { label: "DSM", width: 26 }, { label: "Line", width: 16 },
    { label: "Region", width: 13 }, { label: "Status", width: 10 },
    { label: "Achievement %", width: 14, kind: "pct" }, { label: "Band", width: 15 },
    { label: "Payout %", width: 11, kind: "num" }, { label: "Sales", width: 15, kind: "egp" },
    { label: "Target", width: 15, kind: "egp" }, { label: "Marketing", width: 13, kind: "egp" },
    { label: "Expenses", width: 12, kind: "egp" }, { label: "Visits/mo", width: 11, kind: "num" },
    { label: "Doctors", width: 10, kind: "num" }, { label: "Doubles", width: 10, kind: "num" },
  ];
  const s2 = wb.addWorksheet("Company · DSM league");
  titleBand(s2, dl.length, "DSM LEAGUE TABLE — ALL LINES", `${company.dms.length} target-carrying seats · best first`,
    "Catch-all 'Others' buckets are excluded: they hold unmanaged areas, not a manager.");
  headerRow(s2, 4, dl);
  r = 5;
  company.dms.forEach((d, i) => {
    const region = regionOfDm(review, d.lineId as S1Line, d.dm);
    bodyRow(s2, r++, dl, [
      i + 1, d.dm, d.line, region, d.vacant ? "VACANT" : "active",
      pctOr(d.allProducts.ach), bandLabel(d.allProducts.ach),
      payoutPercentageFor(d.allProducts.ach) || "—",
      d.allProducts.sales, d.allProducts.target, d.marketingCost, d.outstationCost,
      naOr(d.visitsAvgPerMonth, d.visitsAvailable), naOr(d.customersTotal, d.visitsAvailable),
      naOr(d.doubleVisits, d.visitsAvailable),
    ], { achCols: [6], zebra: i % 2 === 1 });
  });

  // -- Company monthly trend --
  const months = company.meta.months;
  const mt: Col[] = [{ label: "Metric", width: 24 }, ...months.map((m) => ({ label: m, width: 13, kind: "num" as const }))];
  const s3 = wb.addWorksheet("Company · Monthly");
  titleBand(s3, mt.length, "COMPANY MONTHLY TREND", company.meta.period, company.meta.doctorNote);
  headerRow(s3, 4, mt);
  bodyRow(s3, 5, mt, ["Sales achievement %", ...months.map((m) => pctOr(T.byMonth[m]?.ach ?? null))],
    { achCols: months.map((_m, i) => i + 2) });
  bodyRow(s3, 6, mt, ["Doctors reached (unique)", ...months.map((m) => T.customersByMonth[m] ?? 0)], { zebra: true });
}

function regionOfDm(review: S1Review, line: S1Line, dm: string): string {
  return review.datasets[line].dms.find((d) => d.dm === dm)?.region ?? "";
}
function bandLabel(ach: number | null): string {
  const b = bandFor(ach);
  return {
    "not-eligible": "< 90% — no payout",
    threshold: "90–100% threshold",
    "on-target": "100–120% on target",
    "over-achiever": "120–150% over",
    elite: "150%+ elite",
  }[b];
}

// ============================== PER LINE ==============================
function addLineSheets(wb: ExcelJS.Workbook, line: S1Line, ds: S1Dataset) {
  const label = ds.meta.line;
  const months = ds.meta.months;
  const avail = ds.visits.available;
  const th = ds.meta.thresholds;
  const graded = (a: AreaSummary) => a.hasTarget && a.allProducts.ach != null;

  // -- DSM league + earners --
  const seats = ds.dms.filter((d) => d.allProducts.target > 0)
    .sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1));
  const dl: Col[] = [
    { label: "#", width: 5, kind: "num" }, { label: "DSM", width: 26 }, { label: "Region", width: 13 },
    { label: "Status", width: 10 }, { label: "Achievement %", width: 14, kind: "pct" },
    { label: "Band", width: 15 }, { label: "Payout %", width: 11, kind: "num" },
    { label: "Sales", width: 15, kind: "egp" }, { label: "Target", width: 15, kind: "egp" },
    { label: "Marketing", width: 13, kind: "egp" }, { label: "Mktg months", width: 11, kind: "num" },
    { label: "Expenses", width: 12, kind: "egp" }, { label: "Visits/mo", width: 11, kind: "num" },
    { label: "Doctors", width: 10, kind: "num" }, { label: "Doubles", width: 10, kind: "num" },
    { label: "Areas", width: 8, kind: "num" },
  ];
  const s1 = wb.addWorksheet(`${label} · DSMs`.slice(0, 31));
  titleBand(s1, dl.length, `${label.toUpperCase()} — DSM LEAGUE TABLE`,
    `${ds.meta.period} · ${seats.length} target-carrying seats`,
    `≥90% unlocks payout (locked 2026 curve). Fail thresholds: rep area <${th.repFailBelow}%, DSM <${th.dsmFailBelow}%.`);
  headerRow(s1, 4, dl);
  let r = 5;
  seats.forEach((d, i) => {
    bodyRow(s1, r++, dl, [
      i + 1, d.dm, d.region, d.vacant ? "VACANT" : "active",
      pctOr(d.allProducts.ach), bandLabel(d.allProducts.ach),
      payoutPercentageFor(d.allProducts.ach) || "—",
      d.allProducts.sales, d.allProducts.target, d.marketingCost, d.marketingMonths, d.outstationCost,
      naOr(d.visitsAvgPerMonth, avail), naOr(d.customersTotal, avail), naOr(d.doubleVisits, avail),
      d.areas.length,
    ], { achCols: [5], zebra: i % 2 === 1 });
  });

  // -- Areas: full list with per-product achievement --
  const keyProducts = ds.products.filter((p) => p.include).map((p) => p.product);
  const bc: Col[] = [
    { label: "Area", width: 30 }, { label: "Region", width: 13 }, { label: "DSM", width: 24 },
    { label: "Status", width: 10 }, { label: "Classification", width: 18 },
    { label: "Achievement %", width: 14, kind: "pct" }, { label: "Payout %", width: 11, kind: "num" },
    { label: "Sales", width: 14, kind: "egp" }, { label: "Target", width: 14, kind: "egp" },
    ...keyProducts.map((p) => ({ label: `${p} %`, width: 15, kind: "pct" as const })),
    { label: "Returns?", width: 10 },
  ];
  const s2 = wb.addWorksheet(`${label} · Areas`.slice(0, 31));
  titleBand(s2, bc.length, `${label.toUpperCase()} — EVERY AREA`,
    `${ds.areas.length} areas · ${ds.areas.filter((a) => a.vacant).length} vacant`,
    "Classification uses the same rules as the dashboard: a vacant area is never an earner or a rep failure.");
  headerRow(s2, 4, bc);
  r = 5;
  const classify = (a: AreaSummary) => {
    if (a.vacant) return "Uncovered (vacant)";
    if (a.ungradeable) return "Ungradeable (no target)";
    if (!graded(a)) return "No target";
    if ((a.allProducts.ach ?? 0) >= 90) return "EARNER ≥90%";
    if ((a.allProducts.ach ?? 999) < th.repFailBelow) return `FAIL <${th.repFailBelow}%`;
    return "On track";
  };
  [...ds.areas]
    .sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1))
    .forEach((a, i) => {
      bodyRow(s2, r++, bc, [
        a.area, a.region, a.dm, a.vacant ? "VACANT" : "active", classify(a),
        pctOr(a.allProducts.ach),
        a.vacant ? "—" : payoutPercentageFor(a.allProducts.ach) || "—",
        a.allProducts.sales, a.allProducts.target,
        ...keyProducts.map((p) => pctOr(a.products?.[p]?.ach ?? null)),
        a.hasReturns ? "RETURNS" : "",
      ], { achCols: [6], zebra: i % 2 === 1 });
    });

  // -- Products + families per month --
  const pc: Col[] = [
    { label: "Family", width: 18 }, { label: "Product", width: 28 }, { label: "Counts?", width: 10 },
    ...months.map((m) => ({ label: `${m} %`, width: 11, kind: "pct" as const })),
    { label: "Total %", width: 12, kind: "pct" }, { label: "Sales", width: 15, kind: "egp" },
    { label: "Target", width: 15, kind: "egp" },
  ];
  const s3 = wb.addWorksheet(`${label} · Products`.slice(0, 31));
  titleBand(s3, pc.length, `${label.toUpperCase()} — ACHIEVEMENT PER PRODUCT PER MONTH`,
    `${ds.meta.period} · ${ds.products.length} SKUs`,
    "'Counts?' = whether the SKU is include-eligible for this line's incentive.");
  headerRow(s3, 4, pc);
  r = 5;
  ds.products
    .filter((p) => p.total.target > 0 || p.total.sales > 0)
    .forEach((p, i) => {
      bodyRow(s3, r++, pc, [
        p.family.trim(), p.product, p.include ? "YES" : "no",
        ...months.map((m) => pctOr(p.byMonth[m]?.ach ?? null)),
        pctOr(p.total.ach), p.total.sales, p.total.target,
      ], { achCols: [...months.map((_m, mi) => mi + 4), months.length + 4], zebra: i % 2 === 1 });
    });

  // family rollup (include-eligible SKUs only, matching the dashboard)
  const famAgg = new Map<string, { n: number; s: Record<string, number>; t: Record<string, number>; ts: number; tt: number }>();
  for (const p of ds.products) {
    if (!p.include) continue;
    const f = famAgg.get(p.family) ?? { n: 0, s: {}, t: {}, ts: 0, tt: 0 };
    f.n += 1;
    for (const m of months) {
      f.s[m] = (f.s[m] ?? 0) + (p.byMonth[m]?.sales ?? 0);
      f.t[m] = (f.t[m] ?? 0) + (p.byMonth[m]?.target ?? 0);
    }
    f.ts += p.total.sales; f.tt += p.total.target;
    famAgg.set(p.family, f);
  }
  if (famAgg.size > 1 && famAgg.size < keyProducts.length) {
    r += 1;
    const hdr = s3.getCell(r, 1);
    hdr.value = "FAMILY ROLLUP — include-eligible SKUs only";
    hdr.font = { bold: true, color: { argb: ORANGE }, size: 11 };
    s3.mergeCells(r, 1, r, pc.length);
    r += 1;
    headerRow(s3, r, pc);
    // headerRow re-freezes/re-filters; restore the sheet's original top-table framing
    s3.views = [{ state: "frozen", ySplit: 4 }];
    s3.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: pc.length } };
    r += 1;
    const div = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
    [...famAgg.entries()]
      .sort((a, b) => (div(b[1].ts, b[1].tt) ?? -1) - (div(a[1].ts, a[1].tt) ?? -1))
      .forEach(([fam, f], i) => {
        bodyRow(s3, r++, pc, [
          fam.trim(), `${f.n} SKU${f.n === 1 ? "" : "s"}`, "YES",
          ...months.map((m) => pctOr(div(f.s[m] ?? 0, f.t[m] ?? 0))),
          pctOr(div(f.ts, f.tt)), f.ts, f.tt,
        ], { achCols: [...months.map((_m, mi) => mi + 4), months.length + 4], bold: true, zebra: i % 2 === 1 });
      });
  }

  // -- Monthly trend + per-DSM monthly achievement --
  const mc: Col[] = [{ label: "DSM / Metric", width: 26 }, ...months.map((m) => ({ label: m, width: 12, kind: "num" as const }))];
  const s4 = wb.addWorksheet(`${label} · Monthly`.slice(0, 31));
  titleBand(s4, mc.length, `${label.toUpperCase()} — MONTHLY DETAIL`, ds.meta.period,
    avail ? undefined : "This line has no CRM visits export — visit and doctor rows are omitted rather than shown as zero.");
  headerRow(s4, 4, mc);
  r = 5;
  bodyRow(s4, r++, mc, ["LINE achievement %", ...months.map((m) => pctOr(ds.line.byMonth[m]?.allProducts.ach ?? null))],
    { achCols: months.map((_m, i) => i + 2), bold: true });
  if (avail) {
    bodyRow(s4, r++, mc, ["LINE visits", ...months.map((m) => ds.visits.byMonth[m] ?? 0)], { zebra: true });
    bodyRow(s4, r++, mc, ["LINE doctors reached", ...months.map((m) => ds.line.customersByMonth[m] ?? 0)]);
  }
  r += 1;
  const dh = s4.getCell(r, 1);
  dh.value = "PER-DSM MONTHLY ACHIEVEMENT %";
  dh.font = { bold: true, color: { argb: ORANGE }, size: 11 };
  s4.mergeCells(r, 1, r, mc.length);
  r += 1;
  seats.forEach((d: DmSummary, i) => {
    bodyRow(s4, r++, mc, [d.dm + (d.vacant ? "  (vacant)" : ""), ...months.map((m) => pctOr(d.achByMonth?.[m] ?? null))],
      { achCols: months.map((_m, mi) => mi + 2), zebra: i % 2 === 1 });
  });

  // -- Spend --
  const sc: Col[] = [
    { label: "DSM", width: 26 }, { label: "Region", width: 13 },
    { label: "Marketing", width: 14, kind: "egp" }, { label: "Mktg requests", width: 12, kind: "num" },
    { label: "Mktg months", width: 12, kind: "num" }, { label: "Outstation", width: 14, kind: "egp" },
    { label: "Outstation rows", width: 14, kind: "num" }, { label: "Total spend", width: 15, kind: "egp" },
    { label: "Sales", width: 15, kind: "egp" }, { label: "Spend per 1k sales", width: 17, kind: "num" },
  ];
  const s5 = wb.addWorksheet(`${label} · Spend`.slice(0, 31));
  titleBand(s5, sc.length, `${label.toUpperCase()} — MARKETING & EXPENSES`,
    `Marketing ${fmt(ds.line.marketingCost)} · Outstation ${fmt(ds.line.outstationCost)}`,
    `${ds.marketing.note} | ${ds.outstation.status}`);
  headerRow(s5, 4, sc);
  r = 5;
  seats.forEach((d, i) => {
    const spend = d.marketingCost + d.outstationCost;
    const per1k = d.allProducts.sales > 0 ? (1000 * spend) / d.allProducts.sales : null;
    bodyRow(s5, r++, sc, [
      d.dm, d.region, d.marketingCost, ds.marketing.byDM?.[d.dm]?.requests ?? 0, d.marketingMonths,
      d.outstationCost, ds.outstation.byDM?.[d.dm]?.rows ?? 0, spend, d.allProducts.sales,
      per1k == null ? "—" : Math.round(per1k * 100) / 100,
    ], { zebra: i % 2 === 1 });
  });
}

const fmt = (n: number) => `EGP ${Math.round(n).toLocaleString("en-US")}`;

// ============================== SUMMARY (one page) ==============================
/** Executive one-pager: the headline numbers, the line table and the full DSM ranking —
 * no per-area, per-product or per-month detail. Same stored values as the full
 * workbook, so the two can never disagree. */
function addSummarySheet(wb: ExcelJS.Workbook, review: S1Review, company: S1Company, view: S1View) {
  const isCompany = view === "company";
  const T = company.total;
  const sheet = wb.addWorksheet("Executive Summary", { properties: { tabColor: { argb: ORANGE } } });
  const NC = 9;
  const lineLabel = isCompany ? "" : review.datasets[view as S1Line].meta.line;
  titleBand(
    sheet, NC,
    isCompany ? "PHOENIX · S1 2026 BUSINESS REVIEW — EXECUTIVE SUMMARY"
              : `PHOENIX · S1 2026 — ${lineLabel.toUpperCase()} EXECUTIVE SUMMARY`,
    `${company.meta.period} · ${isCompany ? "3 lines consolidated" : `${lineLabel} line`}`,
    `${S1_RESTATEMENT_NOTICE} · ≥90% unlocks incentive (locked 2026 curve). Vacant areas are a coverage gap, never an earner or a rep failure.`,
  );
  [26, 16, 16, 14, 14, 13, 11, 11, 24].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  // headline block
  const scoped = isCompany ? null : review.datasets[view as S1Line];
  const ach = scoped ? scoped.line.allProducts.ach : T.allProducts.ach;
  const sales = scoped ? scoped.line.allProducts.sales : T.allProducts.sales;
  const target = scoped ? scoped.line.allProducts.target : T.allProducts.target;
  const mkt = scoped ? scoped.line.marketingCost : T.marketingCost;
  const outn = scoped ? scoped.line.outstationCost : T.outstationCost;
  const visits = scoped ? scoped.line.visits : T.visits;
  const docs = scoped ? scoped.line.customersTotal : T.customersTotal;
  const visAvail = scoped ? scoped.visits.available : true;
  const areas = scoped ? scoped.areas.length : T.areas;
  const vac = scoped ? scoped.areas.filter((a) => a.vacant).length : T.areasVacant;

  let r = 5;
  const kpi = (label: string, value: string | number, sub: string, kind?: Col["kind"], a?: number | null) => {
    const l = sheet.getCell(r, 1); l.value = label;
    l.font = { bold: true, color: { argb: MUTED }, size: 9 };
    const v = sheet.getCell(r, 2); v.value = value;
    v.font = { bold: true, color: { argb: a != null ? achFont(a) : SLATE }, size: 13 };
    if (kind === "egp") v.numFmt = "#,##0";
    if (kind === "pct") v.numFmt = '0.0"%"';
    if (a != null) {
      const f = achFill(a);
      if (f) v.fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
    }
    sheet.mergeCells(r, 4, r, NC);
    const s = sheet.getCell(r, 4); s.value = sub;
    s.font = { color: { argb: MUTED }, size: 9, italic: true };
    r += 1;
  };
  kpi("Achievement", ach ?? 0, "sum(sales) / sum(target)", "pct", ach);
  kpi("Sales", sales, `of ${fmt(target)} target`, "egp");
  kpi("Marketing + expenses", mkt + outn, `${fmt(mkt)} marketing + ${fmt(outn)} outstation`, "egp");
  kpi("Visits", visAvail ? visits : "N/A", visAvail ? `${docs.toLocaleString("en-US")} doctors reached` : "no CRM visits export for this line");
  kpi("Areas", areas, `${vac} vacant (${Math.round((100 * vac) / Math.max(1, areas))}% uncovered)`);

  // line comparison (company scope only)
  if (isCompany) {
    r += 1;
    const h = sheet.getCell(r, 1); h.value = "BY LINE";
    h.font = { bold: true, color: { argb: ORANGE }, size: 11 };
    sheet.mergeCells(r, 1, r, NC); r += 1;
    const lc: Col[] = [
      { label: "Line", width: 26 }, { label: "Achievement %", width: 16, kind: "pct" },
      { label: "Sales", width: 16, kind: "egp" }, { label: "Target", width: 14, kind: "egp" },
      { label: "Marketing", width: 14, kind: "egp" }, { label: "Expenses", width: 13, kind: "egp" },
      { label: "Earners", width: 11, kind: "num" }, { label: "Rep fails", width: 11, kind: "num" },
      { label: "DM seats", width: 24 },
    ];
    headerRow(sheet, r, lc); r += 1;
    company.lines.forEach((l, i) => {
      bodyRow(sheet, r++, lc, [
        l.label, pctOr(l.allProducts.ach), l.allProducts.sales, l.allProducts.target,
        l.marketingCost, l.outstationCost, l.earners, l.repFails,
        `${l.dms}${l.dmsVacant ? ` (+${l.dmsVacant} vacant)` : ""}`,
      ], { achCols: [2], zebra: i % 2 === 1 });
    });
    bodyRow(sheet, r, lc, [
      "COMPANY", pctOr(T.allProducts.ach), T.allProducts.sales, T.allProducts.target,
      T.marketingCost, T.outstationCost,
      company.lines.reduce((s, l) => s + l.earners, 0),
      company.lines.reduce((s, l) => s + l.repFails, 0),
      `${company.lines.reduce((s, l) => s + l.dms, 0)} (+${company.lines.reduce((s, l) => s + l.dmsVacant, 0)} vacant)`,
    ], { achCols: [2], bold: true });
    sheet.getRow(r).eachCell((c) => {
      c.border = { top: { style: "medium", color: { argb: SLATE } }, bottom: { style: "thin", color: { argb: HAIR } } };
    });
    r += 2;
  } else {
    r += 1;
  }

  // DSM ranking
  const h2 = sheet.getCell(r, 1);
  h2.value = isCompany ? "DSM RANKING — ALL LINES" : "DSM RANKING";
  h2.font = { bold: true, color: { argb: ORANGE }, size: 11 };
  sheet.mergeCells(r, 1, r, NC); r += 1;
  const dc: Col[] = [
    { label: "DSM", width: 26 }, { label: "Line", width: 16 }, { label: "Region", width: 16 },
    { label: "Achievement %", width: 14, kind: "pct" }, { label: "Payout %", width: 14, kind: "num" },
    { label: "Sales", width: 13, kind: "egp" }, { label: "Marketing", width: 11, kind: "egp" },
    { label: "Expenses", width: 11, kind: "egp" }, { label: "Status", width: 24 },
  ];
  headerRow(sheet, r, dc); r += 1;
  const seats = isCompany
    ? company.dms.map((d) => ({
        dm: d.dm, line: d.line, region: regionOfDm(review, d.lineId as S1Line, d.dm), vacant: d.vacant,
        ach: d.allProducts.ach, sales: d.allProducts.sales, mkt: d.marketingCost, exp: d.outstationCost,
      }))
    : (scoped as S1Dataset).dms.filter((d) => d.allProducts.target > 0).map((d) => ({
        dm: d.dm, line: lineLabel, region: d.region, vacant: d.vacant,
        ach: d.allProducts.ach, sales: d.allProducts.sales, mkt: d.marketingCost, exp: d.outstationCost,
      }));
  seats.sort((a, b) => (b.ach ?? -1) - (a.ach ?? -1));
  seats.forEach((d, i) => {
    bodyRow(sheet, r++, dc, [
      d.dm, d.line, d.region, pctOr(d.ach), payoutPercentageFor(d.ach) || "—",
      d.sales, d.mkt, d.exp,
      d.vacant ? "VACANT SEAT" : bandLabel(d.ach),
    ], { achCols: [4], zebra: i % 2 === 1 });
  });

  r += 1;
  const g = sheet.getCell(r, 1);
  g.value = company.meta.doctorNote;
  g.font = { color: { argb: MUTED }, size: 8, italic: true };
  sheet.mergeCells(r, 1, r, NC);
}

// ============================== ENTRY ==============================
export type S1WorkbookVariant = "full" | "summary";

/**
 * Builds the whole workbook from ONE canonical range call — all three lines, all six
 * months. The caller (the export route) does not load the review itself, so a company
 * export and a single-line export never risk reading two different snapshots.
 */
export async function generateS1ReviewWorkbook(view: S1View, variant: S1WorkbookVariant = "full") {
  const review = await loadS1Review();
  const company = getS1Company(review);
  const wb = new ExcelJS.Workbook();
  wb.creator = systemDocuments.workbookCreator;
  wb.company = systemDocuments.workbookCompany;
  wb.created = new Date();
  wb.modified = new Date();

  const isCompany = view === "company";
  const scopeLabel = isCompany
    ? "All company — 3 lines consolidated"
    : `${review.datasets[view as S1Line].meta.line} line`;

  if (variant === "summary") {
    addSummarySheet(wb, review, company, view);
    return wb;
  }

  addCover(wb, company, scopeLabel);
  if (isCompany) {
    addCompanySheets(wb, review, company);
    for (const { id } of S1_LINES) addLineSheets(wb, id, review.datasets[id]);
  } else {
    addLineSheets(wb, view, review.datasets[view as S1Line]);
  }
  return wb;
}

export function s1WorkbookFileName(view: S1View, variant: S1WorkbookVariant = "full") {
  const scope = view === "company" ? "All-Company" : (S1_LINES.find((l) => l.id === view)?.label ?? view).replace(/\s+/g, "-");
  const suffix = variant === "summary" ? "-Summary" : "";
  return `Phoenix-S1-2026-Business-Review-${scope}${suffix}.xlsx`;
}
