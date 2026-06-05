import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import type { ExecExportData, ExecutiveReport } from "@/lib/sales/executive-report";
import type { MonthlyClosingComparison } from "@/lib/sales/monthly-closing-comparison";
import {
  bandHeader,
  countifs,
  div0,
  F,
  leaderText,
  planBlocks,
  PCT_FMT,
  sanitizeSheetName,
  sumAll,
  sumifs,
  type TableColumn,
  UNITS_FMT,
  VALUE_FMT,
  writeDataSheet,
  writeTable,
} from "@/lib/sales/sales-workbook-kit";

// Phoenix-branded Executive Report workbook — company-wide (all lines), all-time or one month.
// Every report number is a live Excel formula referencing the hidden Data sheet (written with a
// cached result), so the file opens correct and recalculates when edited. No charts. Five
// report sheets + a hidden Data sheet (added LAST so a report sheet stays the active tab).

type ExecRefs = {
  brkDist: string; brkId: string; brkUnits: string; brkValue: string;
  custCode: string; custDist: string; custUnits: string; custValue: string;
  dpArea: string; dpDist: string; dpLine: string; dpProduct: string; dpRegion: string; dpUnits: string; dpValue: string;
  maCode: string; mbId: string;
};

function planExecData(data: ExecExportData): { blocks: ReturnType<typeof planBlocks>["blocks"]; ref: ExecRefs } {
  const { blocks, rangeOf } = planBlocks([
    {
      headers: ["Line", "Distributor", "Region Code", "Region", "Area Code", "Area", "Product Code", "Product", "Units", "Value"],
      rows: data.distProduct.map((r) => [r.officialLine, r.distributorCode, r.regionCode, r.regionName, r.areaCode, r.areaName, r.productCode, r.productName, r.units, r.value]),
    },
    { headers: ["Client Code", "Client", "Distributor", "Units", "Value"], rows: data.customers.map((c) => [c.clientCode, c.clientName, c.distributorCode, c.units, c.value]) },
    { headers: ["Distributor", "Brick ID", "Brick", "Units", "Value"], rows: data.bricks.map((b) => [b.distributorCode, b.brickId, b.brickName, b.units, b.value]) },
    { headers: ["Area Code", "Area", "Region"], rows: data.masterAreas.map((a) => [a.areaCode, a.areaName, a.regionName]) },
    { headers: ["Brick ID", "Brick", "Area", "Region"], rows: data.masterBricks.map((b) => [b.brickId, b.brickName, b.areaName, b.regionName]) },
  ]);
  const ref: ExecRefs = {
    brkDist: rangeOf(2, "A"), brkId: rangeOf(2, "B"), brkUnits: rangeOf(2, "D"), brkValue: rangeOf(2, "E"),
    custCode: rangeOf(1, "A"), custDist: rangeOf(1, "C"), custUnits: rangeOf(1, "D"), custValue: rangeOf(1, "E"),
    dpArea: rangeOf(0, "E"), dpDist: rangeOf(0, "B"), dpLine: rangeOf(0, "A"), dpProduct: rangeOf(0, "G"), dpRegion: rangeOf(0, "C"), dpUnits: rangeOf(0, "I"), dpValue: rangeOf(0, "J"),
    maCode: rangeOf(3, "A"), mbId: rangeOf(4, "A"),
  };
  return { blocks, ref };
}

function periodLabel(period: string | null) {
  return period ?? "All-time (all months)";
}

function subtitle(report: ExecutiveReport, sheet: string) {
  return `${sheet}  ·  All Lines  ·  Period: ${periodLabel(report.period)}  ·  Values in EGP (live formulas)`;
}

// ── Sheet 1 — Summary & Insights ─────────────────────────────────────────────

function writeSummarySheet(workbook: ExcelJS.Workbook, report: ExecutiveReport, ref: ExecRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Summary & Insights"));
  bandHeader(sheet, 2, "Executive Report", subtitle(report, "Summary & Insights"));
  const c = report.comparison;
  const leader = c.byDistributor[0];
  let row = 4;

  row = writeTable(sheet, row, {
    columns: [{ label: "Metric", width: 26 }, { label: "Value", width: 34 }],
    rows: [
      ["Scope", "All Lines (company-wide)"],
      ["Period", periodLabel(report.period)],
      ["Total Value (EGP)", F(sumAll(ref.dpValue), c.national.value)],
      ["Total Units", F(sumAll(ref.dpUnits), c.national.units)],
      ["Lines", report.byLine.length],
      ["Products sold", c.national.productCount],
      ["Areas with sales", c.national.areaCount],
      ["Distributors", c.distributors.length],
      ["Customers", F(`COUNTA(${ref.custCode})`, c.national.customerCount)],
      ["Leading distributor", leader ? `${leader.distributorName} (${(leader.valueShare * 100).toFixed(1)}%)` : "—"],
    ],
    title: "Key Metrics",
  });

  writeTable(sheet, row, {
    columns: [{ label: "Category", width: 16 }, { label: "Insight", width: 92 }],
    note: "Values in EGP · live formulas referencing the hidden Data sheet · recomputed as Qty × (1 − discount) × factory price · company-wide across every line.",
    rows: c.insights.map((b) => [b.category, b.text]),
    title: "Key Insights",
  });
}

// ── Sheet 2 — By Line & Product ──────────────────────────────────────────────

function writeLineSheet(workbook: ExcelJS.Workbook, report: ExecutiveReport, ref: ExecRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("By Line & Product"));
  bandHeader(sheet, 7, "Executive Report", subtitle(report, "By Line & Product"));
  const c = report.comparison;
  let row = 4;

  row = writeTable(sheet, row, {
    columns: [
      { label: "Line", width: 26 }, { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true },
      { label: "% Share", numFmt: PCT_FMT, right: true }, { label: "Products", numFmt: UNITS_FMT, right: true }, { label: "Areas", numFmt: UNITS_FMT, right: true }, { label: "Distributors", numFmt: UNITS_FMT, right: true },
    ],
    rows: report.byLine.map((l) => [
      l.officialLine,
      F(sumifs(ref.dpUnits, [[ref.dpLine, l.officialLine]]), l.units),
      F(sumifs(ref.dpValue, [[ref.dpLine, l.officialLine]]), l.value),
      F(div0(sumifs(ref.dpValue, [[ref.dpLine, l.officialLine]]), sumAll(ref.dpValue)), l.valueShare),
      l.productCount, l.areaCount, l.distributorCount,
    ]),
    title: "By Line",
    totals: ["TOTAL", F(sumAll(ref.dpUnits), c.national.units), F(sumAll(ref.dpValue), c.national.value), null, null, null, null],
  });

  row = writeTable(sheet, row, {
    columns: [
      { label: "Line", width: 24 }, { label: "Product", width: 26 }, { label: "Code", width: 12 },
      { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }, { label: "% of Line", numFmt: PCT_FMT, right: true },
    ],
    rows: report.lineProduct.map((p) => [
      p.officialLine, p.productName, p.productCode,
      F(sumifs(ref.dpUnits, [[ref.dpLine, p.officialLine], [ref.dpProduct, p.productCode]]), p.units),
      F(sumifs(ref.dpValue, [[ref.dpLine, p.officialLine], [ref.dpProduct, p.productCode]]), p.value),
      F(div0(sumifs(ref.dpValue, [[ref.dpLine, p.officialLine], [ref.dpProduct, p.productCode]]), sumifs(ref.dpValue, [[ref.dpLine, p.officialLine]])), p.lineShare),
    ]),
    title: "Line × Product",
  });

  writeTable(sheet, row, {
    columns: [
      { label: "Line", width: 24 },
      ...c.distributors.map((d) => ({ label: d.name, numFmt: VALUE_FMT, right: true })),
      { dataBar: true, label: "Total", numFmt: VALUE_FMT, right: true }, { label: "Leader", width: 18 },
    ],
    rows: report.lineByDistributor.map((r) => [
      r.label,
      ...c.distributors.map((d) => F(sumifs(ref.dpValue, [[ref.dpDist, d.code], [ref.dpLine, r.key]]), r.byDistributor[d.code] ?? 0)),
      F(sumifs(ref.dpValue, [[ref.dpLine, r.key]]), r.total),
      leaderText(r.leader),
    ]),
    title: "Line × Distributor (Value)",
  });
}

// ── Sheet 3 — By Distributor ─────────────────────────────────────────────────

function writeDistributorSheet(workbook: ExcelJS.Workbook, report: ExecutiveReport, ref: ExecRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("By Distributor"));
  bandHeader(sheet, 9, "Executive Report", subtitle(report, "By Distributor"));
  const c = report.comparison;
  let row = 4;

  row = writeTable(sheet, row, {
    columns: [
      { label: "Distributor", width: 18 }, { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true },
      { label: "% Share", numFmt: PCT_FMT, right: true }, { label: "Products", numFmt: UNITS_FMT, right: true }, { label: "Areas", numFmt: UNITS_FMT, right: true },
      { label: "Bricks", numFmt: UNITS_FMT, right: true }, { label: "Customers", numFmt: UNITS_FMT, right: true }, { label: "Avg Value/Customer", numFmt: VALUE_FMT, right: true, width: 18 },
    ],
    rows: c.byDistributor.map((d) => [
      d.distributorName,
      F(sumifs(ref.dpUnits, [[ref.dpDist, d.distributorCode]]), d.units),
      F(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), d.value),
      F(div0(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), sumAll(ref.dpValue)), d.valueShare),
      d.productCount, d.areaCount, d.brickCount,
      F(countifs([[ref.custDist, d.distributorCode]]), d.customerCount),
      F(div0(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), countifs([[ref.custDist, d.distributorCode]])), d.avgValuePerCustomer),
    ]),
    title: "By Distributor",
    totals: ["TOTAL", F(sumAll(ref.dpUnits), c.national.units), F(sumAll(ref.dpValue), c.national.value), null, null, null, null, null, null],
  });

  const gridColumns = (firstLabel: string): TableColumn[] => [
    { label: firstLabel, width: 24 },
    ...c.distributors.map((d) => ({ label: d.name, numFmt: VALUE_FMT, right: true })),
    { dataBar: true, label: "Total", numFmt: VALUE_FMT, right: true }, { label: "Leader", width: 18 },
  ];
  const gridRows = (rows: MonthlyClosingComparison["productByDistributor"], keyRange: string) =>
    rows.map((r) => [
      r.label,
      ...c.distributors.map((d) => F(sumifs(ref.dpValue, [[ref.dpDist, d.code], [keyRange, r.key]]), r.byDistributor[d.code] ?? 0)),
      F(sumifs(ref.dpValue, [[keyRange, r.key]]), r.total),
      leaderText(r.leader),
    ]);

  row = writeTable(sheet, row, { columns: gridColumns("Product"), rows: gridRows(c.productByDistributor, ref.dpProduct), title: "Product × Distributor (Value)" });
  row = writeTable(sheet, row, { columns: gridColumns("Region"), rows: gridRows(c.regionByDistributor, ref.dpRegion), title: "Region × Distributor (Value)" });

  writeTable(sheet, row, {
    columns: [
      { label: "Distributor", width: 18 }, { label: "Areas Reached", numFmt: UNITS_FMT, right: true }, { label: "Area %", numFmt: PCT_FMT, right: true },
      { label: "Bricks Reached", numFmt: UNITS_FMT, right: true }, { label: "Brick %", numFmt: PCT_FMT, right: true },
    ],
    note: `Coverage vs master: ${c.totalAreas} areas, ${c.totalBricks} bricks.`,
    rows: c.byDistributor.map((d) => [
      d.distributorName,
      d.areaCount,
      F(div0(String(d.areaCount), `COUNTA(${ref.maCode})`), c.totalAreas > 0 ? d.areaCount / c.totalAreas : 0),
      F(countifs([[ref.brkDist, d.distributorCode], [ref.brkValue, ">0"]]), d.brickCount),
      F(div0(countifs([[ref.brkDist, d.distributorCode], [ref.brkValue, ">0"]]), `COUNTA(${ref.mbId})`), c.totalBricks > 0 ? d.brickCount / c.totalBricks : 0),
    ]),
    title: "Coverage",
  });
}

// ── Sheet 4 — By Region & Area ───────────────────────────────────────────────

function writeGeographySheet(workbook: ExcelJS.Workbook, report: ExecutiveReport, ref: ExecRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("By Region & Area"));
  bandHeader(sheet, 5, "Executive Report", subtitle(report, "By Region & Area"));
  const c = report.comparison;
  let row = 4;

  // Region + area aggregates derived from the leaf facts (no double counting).
  const regionAgg = new Map<string, { regionCode: string; regionName: string; units: number; value: number }>();
  const areaAgg = new Map<string, { areaCode: string; areaName: string; regionName: string; units: number; value: number }>();
  report.data.distProduct.forEach((r) => {
    const rg = regionAgg.get(r.regionCode) ?? { regionCode: r.regionCode, regionName: r.regionName, units: 0, value: 0 };
    rg.units += r.units; rg.value += r.value; regionAgg.set(r.regionCode, rg);
    const ar = areaAgg.get(r.areaCode) ?? { areaCode: r.areaCode, areaName: r.areaName, regionName: r.regionName, units: 0, value: 0 };
    ar.units += r.units; ar.value += r.value; areaAgg.set(r.areaCode, ar);
  });
  const regions = [...regionAgg.values()].sort((a, b) => b.value - a.value);
  const areas = [...areaAgg.values()].sort((a, b) => a.regionName.localeCompare(b.regionName) || b.value - a.value);

  row = writeTable(sheet, row, {
    columns: [
      { label: "Region", width: 22 }, { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }, { label: "% Share", numFmt: PCT_FMT, right: true },
    ],
    rows: regions.map((rg) => [
      rg.regionName,
      F(sumifs(ref.dpUnits, [[ref.dpRegion, rg.regionCode]]), rg.units),
      F(sumifs(ref.dpValue, [[ref.dpRegion, rg.regionCode]]), rg.value),
      F(div0(sumifs(ref.dpValue, [[ref.dpRegion, rg.regionCode]]), sumAll(ref.dpValue)), c.national.value > 0 ? rg.value / c.national.value : 0),
    ]),
    title: "By Region",
    totals: ["TOTAL", F(sumAll(ref.dpUnits), c.national.units), F(sumAll(ref.dpValue), c.national.value), null],
  });

  writeTable(sheet, row, {
    columns: [
      { label: "Area", width: 24 }, { label: "Region", width: 18 }, { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }, { label: "% Share", numFmt: PCT_FMT, right: true },
    ],
    note: "Each area is counted once; region totals are roll-ups of their areas.",
    rows: areas.map((ar) => [
      ar.areaName, ar.regionName,
      F(sumifs(ref.dpUnits, [[ref.dpArea, ar.areaCode]]), ar.units),
      F(sumifs(ref.dpValue, [[ref.dpArea, ar.areaCode]]), ar.value),
      F(div0(sumifs(ref.dpValue, [[ref.dpArea, ar.areaCode]]), sumAll(ref.dpValue)), c.national.value > 0 ? ar.value / c.national.value : 0),
    ]),
    title: "By Area",
  });
}

// ── Sheet 5 — Rankings, Mix & Gaps ───────────────────────────────────────────

function writeRankingsSheet(workbook: ExcelJS.Workbook, report: ExecutiveReport, ref: ExecRefs) {
  const sheet = workbook.addWorksheet(sanitizeSheetName("Rankings, Mix & Gaps"));
  bandHeader(sheet, 6, "Executive Report", subtitle(report, "Rankings, Mix & Gaps"));
  const c = report.comparison;
  const distName = new Map(c.distributors.map((d) => [d.code, d.name]));
  let row = 4;

  const rankCols = (label: string, sub?: string): TableColumn[] => [
    { label: "#", numFmt: UNITS_FMT, right: true, width: 5 }, { label, width: 24 },
    ...(sub ? [{ label: sub, width: 16 } as TableColumn] : []),
    { label: "Units", numFmt: UNITS_FMT, right: true }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }, { label: "% Share", numFmt: PCT_FMT, right: true },
  ];
  const keyRank = (rows: MonthlyClosingComparison["rankings"]["products"], keyUnits: string, keyValue: string, keyRange: string, withSub: boolean) =>
    rows.map((r) => {
      const value = F(sumifs(keyValue, [[keyRange, r.key]]), r.value);
      const units = F(sumifs(keyUnits, [[keyRange, r.key]]), r.units);
      const share = F(div0(sumifs(keyValue, [[keyRange, r.key]]), sumAll(keyValue)), r.share);
      return withSub ? [r.rank, r.label, r.sublabel, units, value, share] : [r.rank, r.label, units, value, share];
    });

  row = writeTable(sheet, row, { columns: rankCols("Product", "Code"), rows: keyRank(c.rankings.products, ref.dpUnits, ref.dpValue, ref.dpProduct, true), title: "Top 10 Products" });
  row = writeTable(sheet, row, { columns: rankCols("Area", "Region"), rows: keyRank(c.rankings.areas, ref.dpUnits, ref.dpValue, ref.dpArea, true), title: "Top 10 Areas" });
  row = writeTable(sheet, row, { columns: rankCols("Region"), rows: keyRank(c.rankings.regions, ref.dpUnits, ref.dpValue, ref.dpRegion, false), title: "Top 10 Regions" });
  row = writeTable(sheet, row, { columns: rankCols("Brick", "Brick ID"), rows: keyRank(c.rankings.bricks, ref.brkUnits, ref.brkValue, ref.brkId, true), title: "Top 10 Bricks" });

  const topCustomers = [...c.data.customers].sort((a, b) => b.value - a.value).slice(0, 10);
  const custTotal = c.data.customers.reduce((sum, cu) => sum + cu.value, 0);
  row = writeTable(sheet, row, {
    columns: rankCols("Customer", "Distributor"),
    rows: topCustomers.map((cu, index) => [
      index + 1, cu.clientName, distName.get(cu.distributorCode) ?? cu.distributorCode,
      F(sumifs(ref.custUnits, [[ref.custCode, cu.clientCode], [ref.custDist, cu.distributorCode]]), cu.units),
      F(sumifs(ref.custValue, [[ref.custCode, cu.clientCode], [ref.custDist, cu.distributorCode]]), cu.value),
      F(div0(sumifs(ref.custValue, [[ref.custCode, cu.clientCode], [ref.custDist, cu.distributorCode]]), sumAll(ref.custValue)), custTotal > 0 ? cu.value / custTotal : 0),
    ]),
    title: "Top 10 Customers",
  });

  const mixCols: TableColumn[] = [{ label: "Label", width: 24 }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }, { label: "% Share", numFmt: PCT_FMT, right: true }];
  row = writeTable(sheet, row, {
    columns: mixCols,
    rows: c.byDistributor.map((d) => [d.distributorName, F(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), d.value), F(div0(sumifs(ref.dpValue, [[ref.dpDist, d.distributorCode]]), sumAll(ref.dpValue)), d.valueShare)]),
    title: "Distributor Mix",
  });
  row = writeTable(sheet, row, {
    columns: mixCols,
    rows: report.byLine.map((l) => [l.officialLine, F(sumifs(ref.dpValue, [[ref.dpLine, l.officialLine]]), l.value), F(div0(sumifs(ref.dpValue, [[ref.dpLine, l.officialLine]]), sumAll(ref.dpValue)), l.valueShare)]),
    title: "Line Mix",
  });

  row = writeTable(sheet, row, {
    columns: [{ label: "Area", width: 22 }, { label: "Region", width: 16 }, { label: "Sales (proof)", numFmt: VALUE_FMT, right: true }],
    note: `${c.whiteSpace.zeroSalesAreas.length} of ${c.totalAreas} areas had zero sales.`,
    rows: c.whiteSpace.zeroSalesAreas.slice(0, 100).map((a) => [a.areaName, a.regionName, F(sumifs(ref.dpValue, [[ref.dpArea, a.areaCode]]), 0)]),
    title: "Zero-Sales Areas",
  });
  row = writeTable(sheet, row, {
    columns: [{ label: "Area", width: 22 }, { label: "Region", width: 16 }, { label: "Only Distributor", width: 18 }, { dataBar: true, label: "Value", numFmt: VALUE_FMT, right: true }],
    rows: c.whiteSpace.singleDistributorAreas.slice(0, 100).map((s) => [s.areaName, s.regionName, s.distributorName, F(sumifs(ref.dpValue, [[ref.dpArea, s.areaCode]]), s.value)]),
    title: "Single-Distributor Areas",
  });
  writeTable(sheet, row, {
    columns: [{ label: "Product", width: 24 }, { label: "Sold Regions", width: 32 }, { label: "Missing Regions", width: 32 }, { label: "# Missing", numFmt: UNITS_FMT, right: true }],
    rows: c.whiteSpace.productGaps.map((g) => [g.productName, g.soldRegions.join(", "), g.missingRegions.join(", "), g.missingRegions.length]),
    title: "Product Gaps (regions with no sales)",
  });
}

export async function buildExecutiveReportWorkbook(report: ExecutiveReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  const { blocks, ref } = planExecData(report.data);
  writeSummarySheet(workbook, report, ref);
  writeLineSheet(workbook, report, ref);
  writeDistributorSheet(workbook, report, ref);
  writeGeographySheet(workbook, report, ref);
  writeRankingsSheet(workbook, report, ref);
  writeDataSheet(workbook, blocks);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
