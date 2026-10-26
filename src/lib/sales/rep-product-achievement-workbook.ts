import ExcelJS from "exceljs";

import { HOUSE_XLSX_SIGNAL } from "@/lib/export/house-xlsx-palette";
import {
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseCalloutStyle,
  houseGeneratedAt,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { unprotectExcelWorkbook } from "@/lib/sales/closing-workbook-lock";
import {
  achievementBand,
  describeAchievementCell,
  semesterLabel,
  type AchievementCell,
  type PeriodColumn,
  type RepAchievementData,
  type RepAchievementRecord,
} from "@/lib/sales/rep-product-achievement";

// ─────────────────────────────────────────────────────────────────────────────
// THE REP ACHIEVEMENT WORKBOOK — what the Training Manager downloads, holding exactly the reps her
// filters showed (the route runs the page's own `filterRepAchievement`).
//
// Three sheets, house identity (SATO-DIS-2026-01): "By rep and product" — one row per rep per
// product, the rep's all-products row first and in bold, the nine period columns; "Rep overall" — one row
// per rep; "How to read" — what a percentage is and what each word in a cell means.
//
// A percentage is stored as its RATIO with a percent format, so Excel can filter and recompute it;
// a cell with no percentage carries its WORD ("Not published", "No target"), never a 0. The status
// signal — green from 100%, amber from 80%, red under — is the house's narrow traffic-light
// exemption (house-xlsx-palette.ts), on the period cells only. The workbook is locked like every
// closing-derived export (closing-workbook-lock.ts): she can select and filter, not edit.
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_HEADERS = ["Rep", "Line", "Area", "Region", "Manager", "Hired", "Status"] as const;
const IDENTITY_WIDTHS = [28, 14, 20, 18, 26, 13, 10];
/** The detail sheet carries every identity column but Status, then Product. */
const DETAIL_IDENTITY = IDENTITY_HEADERS.length - 1;
const HIRE_DATE_FORMAT = "d mmm yyyy";
const PERIOD_WIDTH = 12;
const PERCENT_FORMAT = "0.0%";

function periodHead(column: PeriodColumn, partialHeads: ReadonlySet<string>): string {
  return partialHeads.has(column.id) ? `${column.fullLabel} to date` : column.fullLabel;
}

function writePeriodCell(cell: ExcelJS.Cell, value: AchievementCell | undefined, zebra: boolean, strong: boolean) {
  houseBodyStyle(cell, { zebra });
  cell.alignment = { horizontal: "center", vertical: "middle" };
  if (!value) {
    cell.value = "—";
    cell.font = { ...cell.font, color: { argb: HOUSE_XLSX_COLORS.muted } };
    return;
  }
  if (value.state === "graded" && value.value != null) {
    cell.value = value.value;
    cell.numFmt = PERCENT_FORMAT;
    const band = achievementBand(value.value);
    if (band) {
      const signal = HOUSE_XLSX_SIGNAL[band];
      cell.fill = { fgColor: { argb: signal.tint }, pattern: "solid", type: "pattern" };
      cell.font = { ...cell.font, bold: strong, color: { argb: signal.ink } };
    }
    return;
  }
  cell.value = describeAchievementCell(value).short;
  cell.font = { ...cell.font, color: { argb: HOUSE_XLSX_COLORS.muted }, size: 9 };
}

/** The hire date as a real Excel date (UTC midnight, so the day never moves), or a dash. */
function hireDateValue(hireDate: string | null): Date | string {
  const match = hireDate?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : "—";
}

function identityValues(record: RepAchievementRecord): (string | Date)[] {
  return [
    record.name,
    record.lineName,
    record.areaName || "—",
    record.regionName || "—",
    record.managerName || "—",
    hireDateValue(record.hireDate),
    record.left ? "Left" : "Active",
  ];
}

function writeIdentity(row: ExcelJS.Row, values: readonly (string | Date)[], zebra: boolean, strong: boolean) {
  values.forEach((value, index) => {
    const cell = row.getCell(index + 1);
    cell.value = value;
    houseBodyStyle(cell, { zebra });
    if (strong) cell.font = { ...cell.font, bold: true, color: { argb: HOUSE_XLSX_COLORS.deep } };
    cell.alignment = { vertical: "middle", wrapText: true };
    if (value instanceof Date) {
      cell.numFmt = HIRE_DATE_FORMAT;
      cell.alignment = { horizontal: "left", vertical: "middle" };
    }
  });
}

function writeHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number, heads: readonly string[]) {
  const row = sheet.getRow(rowNumber);
  heads.forEach((head, index) => {
    const cell = row.getCell(index + 1);
    cell.value = head;
    houseHeaderStyle(cell, { center: index >= IDENTITY_HEADERS.length });
  });
  row.height = 30;
}

export type RepAchievementWorkbookInput = {
  data: RepAchievementData;
  records: readonly RepAchievementRecord[];
  /** "Line: CNS", "Product: Gaumycin" — what was active when she pressed Export. */
  activeFilters: Record<string, string>;
};

/** The columns whose head says "to date" — any quarter or semester with a month not yet started. */
function partialColumns(data: RepAchievementData): Set<string> {
  const current = data.currentPeriod;
  const out = new Set<string>();
  for (const column of data.columns) {
    if (column.kind !== "month" && column.months.some((month) => month > current)) out.add(column.id);
  }
  return out;
}

export async function buildRepAchievementWorkbook(input: RepAchievementWorkbookInput): Promise<ExcelJS.Workbook> {
  const { activeFilters, data, records } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(data.generatedAt);

  const partial = partialColumns(data);
  const periodHeads = data.columns.map((column) => periodHead(column, partial));
  const filterLine = Object.entries(activeFilters)
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ");
  const provenance = [
    `Generated ${houseGeneratedAt(data.generatedAt)}`,
    `${records.length} rep${records.length === 1 ? "" : "s"}`,
    filterLine || "All lines, every rep",
  ];
  const subtitle = `${semesterLabel(data.semester)} · sales ÷ target from the published Monthly Closing`;

  // ── Sheet 1: one row per rep per product ──────────────────────────────────
  const detail = workbook.addWorksheet("By rep and product", { views: [{ showGridLines: false }] });
  const detailHeads = [...IDENTITY_HEADERS.slice(0, DETAIL_IDENTITY), "Product", ...periodHeads];
  const detailFirstPeriod = DETAIL_IDENTITY + 2;
  detail.columns = [...IDENTITY_WIDTHS.slice(0, DETAIL_IDENTITY), 26, ...periodHeads.map(() => PERIOD_WIDTH)].map((width) => ({ width }));
  let next = writeHouseMasthead(workbook, detail, {
    columns: detailHeads.length,
    provenance,
    subtitle,
    title: "Rep Achievement by Product",
  });
  next += 1;
  const detailHeaderRow = next;
  writeHeaderRow(detail, detailHeaderRow, detailHeads);
  next += 1;
  let band = 0;
  for (const record of records) {
    const zebra = band % 2 === 1;
    band += 1;
    const identity = identityValues(record).slice(0, DETAIL_IDENTITY);
    const overallRow = detail.getRow(next);
    writeIdentity(overallRow, [...identity, "All products"], zebra, true);
    record.overall.forEach((cell, index) => writePeriodCell(overallRow.getCell(detailFirstPeriod + index), cell, zebra, true));
    next += 1;
    for (const product of record.products) {
      const row = detail.getRow(next);
      writeIdentity(row, [...identity, product.productName], zebra, false);
      product.cells.forEach((cell, index) => writePeriodCell(row.getCell(detailFirstPeriod + index), cell, zebra, false));
      next += 1;
    }
  }
  detail.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: detailHeaderRow }];
  if (next > detailHeaderRow + 1) {
    detail.autoFilter = { from: { column: 1, row: detailHeaderRow }, to: { column: detailHeads.length, row: next - 1 } };
  }

  // ── Sheet 2: one row per rep ──────────────────────────────────────────────
  const overall = workbook.addWorksheet("Rep overall", { views: [{ showGridLines: false }] });
  const overallHeads = [...IDENTITY_HEADERS, ...periodHeads];
  overall.columns = [...IDENTITY_WIDTHS, ...periodHeads.map(() => PERIOD_WIDTH)].map((width) => ({ width }));
  next = writeHouseMasthead(workbook, overall, {
    columns: overallHeads.length,
    provenance,
    subtitle: `${subtitle} · every product together, by value`,
    title: "Rep Achievement · All Products",
  });
  next += 1;
  const overallHeaderRow = next;
  writeHeaderRow(overall, overallHeaderRow, overallHeads);
  next += 1;
  records.forEach((record, index) => {
    const zebra = index % 2 === 1;
    const row = overall.getRow(next);
    writeIdentity(row, identityValues(record), zebra, false);
    record.overall.forEach((cell, column) => writePeriodCell(row.getCell(IDENTITY_HEADERS.length + 1 + column), cell, zebra, false));
    next += 1;
  });
  overall.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: overallHeaderRow }];
  if (next > overallHeaderRow + 1) {
    overall.autoFilter = { from: { column: 1, row: overallHeaderRow }, to: { column: overallHeads.length, row: next - 1 } };
  }

  // ── Sheet 3: how to read it ───────────────────────────────────────────────
  const notes = workbook.addWorksheet("How to read", { views: [{ showGridLines: false }] });
  notes.columns = [{ width: 26 }, { width: 90 }, { width: 14 }, { width: 14 }];
  next = writeHouseMasthead(workbook, notes, { columns: 6, provenance, subtitle, title: "How to read this workbook" });
  next += 1;
  const published = data.lines
    .map((line) => {
      const months = data.publishedMonths[line.value] ?? [];
      const names = data.columns.filter((column) => column.kind === "month" && months.includes(column.id)).map((column) => column.label);
      return `${line.label}: ${names.length ? names.join(", ") : "nothing published yet"}`;
    })
    .join(" · ");
  const lines: Array<[string, string]> = [
    ["A percentage", "The rep's sales of that product over the column's published months, divided once by the rep's target over the same months. A quarter and a semester are summed and divided once, never an average of monthly percentages."],
    ["All products", "Every product the rep carries, together, by value. Units of different products are never added."],
    ["Published months", published],
    ["Not published", "That line has not published the month's closing yet. It is never shown as 0%."],
    ["No target", "The rep sold or carried the product but held no target for it in those months. Not a 0%."],
    ["—", "No sales and no target of that product in those months."],
    ["Upcoming", "The month has not started."],
    ["to date", "A quarter or semester whose later months have not started: graded on the months that have."],
    ["Colours", "Green from 100%, amber from 80% to 99.9%, red under 80%."],
    ["Left", "The rep has left the company. The months the rep held the seat stay credited to them."],
  ];
  for (const [label, text] of lines) {
    const row = notes.getRow(next);
    row.getCell(1).value = label;
    houseCalloutStyle(row.getCell(1), { emphasis: true });
    row.getCell(2).value = text;
    houseCalloutStyle(row.getCell(2));
    row.height = Math.max(20, Math.ceil(text.length / 95) * 15);
    next += 1;
  }

  unprotectExcelWorkbook(workbook);
  return workbook;
}
