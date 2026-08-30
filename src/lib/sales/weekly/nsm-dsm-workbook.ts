// Weekly Sales — "NSM/DSM Export": the field-manager workbook.
//
// A THIRD export alongside the analyst BI workbook (export-workbook.ts, ExcelForge) and the
// Summarized Report (summary-workbook.ts, ExcelJS). Neither is touched by this file and this file
// imports neither builder, so the three cannot drift into each other.
//
// WHAT IT IS. The two books the owner reviewed on 2026-08-30, reproduced from live data and scoped
// by whatever filters are on screen: seven tabs, a product-by-week grid in UNITS, and a masthead
// that states in plain English which days the numbers actually cover. It is written for a national
// or district sales manager reading it once, on paper, at speed.
//
// EVERY figure comes from WeeklyDashboard.factRows, which loadWeeklyDashboard has already
// de-cumulated (W2 minus W1 = what W2 actually sold), re-valued at current Product Master price,
// and access-scope redacted — the same grain the Summarized Report uses, and the reason this
// workbook reconciles exactly to the screen for the same filters.
//
// THE THREE RULES THIS FILE EXISTS TO KEEP (each cost a rebuild during the review):
//
//  1. UNITS ARE NEVER ADDED ACROSS PRODUCTS (owner rule). A unit figure is valid for ONE product
//     code. Every unit cell here sits under exactly one product; anything spanning products is
//     money. There is no "total units" column anywhere in this workbook, deliberately.
//
//  2. THE WEEKS ON A ROW MUST ADD TO THE MONTH BESIDE THEM, and each column must still add to the
//     line. Rounding each column independently broke 43 rows in review. See `roundColumns`.
//
//  3. PRODUCT ORDER IS THE LINE'S, NEVER THE VIEW'S. A district's own ranking can differ from the
//     line's, and then column three means a different product in the DSM's book than in the NSM's —
//     exactly what two people compare over the phone and get wrong.

import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { sanitizeSheetName } from "@/lib/sales/sales-workbook-kit";
import type { WeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { splitWeeklyRowsByBranch } from "@/lib/sales/weekly/branch-attribution";
import {
  resolveWeeklyManager,
  type WeeklyManagerIndex,
} from "@/lib/sales/weekly/manager-attribution";
import type { WeeklyFactExportRow } from "@/lib/sales/weekly/types";

// ── palette ─────────────────────────────────────────────────────────────────────
// Deliberately quieter than the BI workbook's slate slabs: this one is printed, and a manager
// reading it on paper wants ink on white with one accent, not a dark band per section.
const INK = "FF1A1A1A";
const SUB = "FF6B6B6B";
const FAINT = "FFAAB0B6";
const RULE = "FFE4E4E4";
const RULE_STRONG = "FF9AA0A6";
const HEAD = "FFF3F1EE";
const HEAD_SOFT = "FFFAF8F5";
const TOTAL_BG = "FFEBE8E3";
const ZEBRA = "FFF4F1EC";
const ACCENT = "FFF97316";

const F_UNITS = "#,##0";
const F_VALUE = "#,##0";
const F_PCT = "0.0%";

/** Column widths are in character units of the 11pt default font, so a string of N characters at
 *  font size S needs roughly N * (S/11) units. That is what makes "fit the text" measurable. */
const widthOf = (text: string, size = 10) => text.length * (size / 11) + 2;

// ── inputs ──────────────────────────────────────────────────────────────────────

export type NsmDsmWorkbookInput = {
  /** De-cumulated fact grain for the viewer's current filters. NOT yet split by branch → area. */
  rows: WeeklyFactExportRow[];
  areaSplit: WeeklyAreaSplitIndex | null;
  managerIndex: WeeklyManagerIndex;
  /** area_code → area_name, so a sheet reads "Gharbia 2 (Mahalla)" rather than "D21". */
  areaNames: Map<string, string>;
  /** region_code → region_name, so a section reads "Upper Egypt" rather than "UE". */
  regionNames: Map<string, string>;
  /** Lines the viewer named. More than one splits the workbook into a tab set per line. */
  lineFilter: string[];
  /**
   * Ordered product codes forming the column AXIS, from the dashboard's stable filter universe.
   * Optional: with none supplied the order falls back to the value present in these rows, which is
   * only safe when a single book is ever built from a sheet.
   */
  productAxis?: string[];
  /** Region codes the viewer actually asked for - whose book this is, regardless of split spill. */
  regionFilter?: string[];
  /** e.g. "August 2026" — the period the figures cover, for the big date beside the title. */
  periodLabel: string;
  generatedAt: string;
};

type Split = WeeklyFactExportRow & { _weight: number };

// ── small numeric helpers ───────────────────────────────────────────────────────

/**
 * Round a list of floats to integers whose sum is exactly `target` (largest-remainder / Hare).
 *
 * Printed columns have to add up. Rounding each cell on its own leaves the column short or long by
 * a few units, and a manager who adds a column by hand and lands one off stops trusting the sheet.
 */
export function conserveRound(values: number[], target?: number): number[] {
  const floors = values.map((value) => Math.floor(value));
  const want = target ?? Math.round(values.reduce((sum, value) => sum + value, 0));
  let short = want - floors.reduce((sum, value) => sum + value, 0);
  const order = values
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((left, right) => right.rest - left.rest || left.index - right.index);
  const out = floors.slice();
  // `short` can be negative when the caller's target is below the sum of floors (a region whose
  // exact total rounds down). Give units out, or take them back, one at a time.
  let cursor = 0;
  while (short > 0 && order.length > 0) {
    out[order[cursor % order.length].index] += 1;
    short -= 1;
    cursor += 1;
  }
  cursor = 0;
  while (short < 0 && order.length > 0) {
    const index = order[order.length - 1 - (cursor % order.length)].index;
    if (out[index] > 0) {
      out[index] -= 1;
      short += 1;
    } else if (cursor > order.length * 2) {
      break;
    }
    cursor += 1;
  }
  return out;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// ── attribution ─────────────────────────────────────────────────────────────────

/**
 * Split every fact row into one row per area its branch serves, and stamp the OPERATIONAL region.
 *
 * The region a row carries is the distributor's geography. Which region a manager owns is a
 * property of the AREA on that LINE, from the organogram — those two disagree often enough that
 * reading the row's own region code puts areas in two regions at once on the same sheet.
 */
function explode(input: NsmDsmWorkbookInput, rows: WeeklyFactExportRow[]): Split[] {
  const { rows: split } = splitWeeklyRowsByBranch(rows, input.areaSplit);
  return split.map((row) => {
    const bucket = resolveWeeklyManager(input.managerIndex, row.line, row.regionCode, row.areaCode);
    const scope = bucket.scopeLabel.split("·").pop()?.trim() ?? "";
    return {
      ...row,
      regionName: scope || row.regionName || row.regionCode,
      _weight: 1,
    } as Split;
  });
}

/** Region a row is reported under, resolved through the organogram rather than the row's own code. */
function regionOf(input: NsmDsmWorkbookInput, row: WeeklyFactExportRow): string {
  const bucket = resolveWeeklyManager(input.managerIndex, row.line, row.regionCode, row.areaCode);
  if (bucket.kind === "dm" || bucket.kind === "vacant") {
    const tail = bucket.scopeLabel.split("·").pop()?.trim();
    if (tail) return tail;
  }
  const named = input.regionNames.get((row.regionCode ?? "").trim().toUpperCase());
  return named || row.regionName || row.regionCode || "Unmapped";
}

const areaLabel = (input: NsmDsmWorkbookInput, row: WeeklyFactExportRow) => {
  const code = (row.areaCode ?? "").trim().toUpperCase();
  if (!code) return "Region level (no single area)";
  return input.areaNames.get(code) ?? code;
};

// ── the grid ────────────────────────────────────────────────────────────────────

type Measure = string; // "W1".."W4" | "M" | "S"

type Group = {
  id: Record<string, string>;
  region: string;
  /** `${productCode}||${measure}` → exact (unrounded) units. */
  exact: Map<string, number>;
  /** the same keys, rounded for print */
  print: Map<string, number>;
  value: number;
  stockValue: number;
};

const cellKey = (productCode: string, measure: Measure) => `${productCode}||${measure}`;

/**
 * Round the week columns, then DERIVE each month from the weeks actually printed beside it.
 *
 * Rounding the weeks and the month independently is what left 43 rows in review where W1+W2+W3+W4
 * did not equal the Month next to them. Rounding happens per REGION so a region reads identically
 * in the district manager's book and the national manager's — the district's own rounding must not
 * depend on rows that are not in his file.
 */
function roundColumns(groups: Group[], keys: string[], lineTargets: Map<string, number> | null): void {
  const buckets = new Map<string, Group[]>();
  for (const group of groups) {
    const bucket = buckets.get(group.region) ?? [];
    bucket.push(group);
    buckets.set(group.region, bucket);
  }
  for (const key of keys) {
    for (const bucket of buckets.values()) {
      const values = bucket.map((group) => group.exact.get(key) ?? 0);
      const rounded = conserveRound(values);
      bucket.forEach((group, index) => group.print.set(key, rounded[index]));
    }
    if (lineTargets) {
      // A grain with no region column (by distributor) cannot bucket, so it is rounded once
      // against the line's own target instead — the same number the regional buckets sum to.
      const target = lineTargets.get(key);
      if (target !== undefined && buckets.size === 1 && buckets.has("*")) {
        const bucket = buckets.get("*") ?? [];
        const rounded = conserveRound(bucket.map((group) => group.exact.get(key) ?? 0), target);
        bucket.forEach((group, index) => group.print.set(key, rounded[index]));
      }
    }
  }
}

/** Per (product, measure) integer target for the whole line: each region rounded, then summed. */
function lineTargetsFor(rows: Split[], weekNumbers: number[], input: NsmDsmWorkbookInput): Map<string, number> {
  const byRegion = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const region = regionOf(input, row);
    const bucket = byRegion.get(region) ?? new Map<string, number>();
    for (const measure of measuresOf(row, weekNumbers)) {
      const key = cellKey(row.productCode, measure.measure);
      bucket.set(key, (bucket.get(key) ?? 0) + measure.units);
    }
    byRegion.set(region, bucket);
  }
  const out = new Map<string, number>();
  for (const bucket of byRegion.values()) {
    for (const [key, value] of bucket) out.set(key, (out.get(key) ?? 0) + Math.round(value));
  }
  return out;
}

/** Every (measure, units) a single fact row contributes: its own week, the month, and stock. */
function measuresOf(row: WeeklyFactExportRow, weekNumbers: number[]): { measure: Measure; units: number }[] {
  const out: { measure: Measure; units: number }[] = [{ measure: "M", units: num(row.salesUnits) }];
  const week = row.weekNumber;
  if (week !== null && weekNumbers.includes(week)) out.push({ measure: `W${week}`, units: num(row.salesUnits) });
  if (num(row.stockUnits) !== 0) out.push({ measure: "S", units: num(row.stockUnits) });
  return out;
}

type TabKey = "area" | "branch" | "dist" | "ranked" | "stock" | "details";

const ID_COLUMNS: Record<TabKey, string[]> = {
  area: ["Region", "Area"],
  branch: ["Distributor", "Branch", "Region", "Area"],
  dist: ["Distributor"],
  ranked: ["Distributor", "Branch", "Region", "Area"],
  stock: ["Distributor", "Branch", "Region", "Area"],
  details: ["Distributor", "Branch", "Region", "Area"],
};

const TAB_TITLE: Record<TabKey, string> = {
  area: "Sales by area",
  branch: "Sales by branch",
  dist: "Sales by distributor",
  ranked: "Branches ranked",
  stock: "Stock with no sales",
  details: "Details",
};

const TAB_SHEET: Record<TabKey, string> = {
  area: "By area",
  branch: "By branch",
  dist: "By distributor",
  ranked: "Ranked",
  stock: "Stock",
  details: "Details",
};

function idOf(input: NsmDsmWorkbookInput, row: Split, tab: TabKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of ID_COLUMNS[tab]) {
    if (column === "Region") out[column] = regionOf(input, row);
    else if (column === "Area") out[column] = areaLabel(input, row);
    else if (column === "Branch") out[column] = row.branchName || row.branchCode;
    else if (column === "Distributor") out[column] = row.distributorName || row.distributorCode;
  }
  return out;
}

function buildGroups(
  input: NsmDsmWorkbookInput,
  rows: Split[],
  tab: TabKey,
  weekNumbers: number[],
  unitPrice: Map<string, number>,
): Group[] {
  const byKey = new Map<string, Group>();
  for (const row of rows) {
    const id = idOf(input, row, tab);
    const key = ID_COLUMNS[tab].map((column) => id[column]).join("||");
    let group = byKey.get(key);
    if (!group) {
      group = {
        id,
        region: tab === "dist" ? "*" : regionOf(input, row),
        exact: new Map(),
        print: new Map(),
        value: 0,
        stockValue: 0,
      };
      byKey.set(key, group);
    }
    for (const measure of measuresOf(row, weekNumbers)) {
      const cell = cellKey(row.productCode, measure.measure);
      group.exact.set(cell, (group.exact.get(cell) ?? 0) + measure.units);
    }
    group.value += num(row.salesValue);
  }

  let groups = [...byKey.values()];

  if (tab === "stock") {
    // Branches holding stock that sold NOTHING this period. Filtered on the EXACT floats, before
    // rounding: a branch with 0.4 units of sales has sold something, and rounding it to zero would
    // put it on a sheet whose whole point is that these branches sold nothing.
    groups = groups.filter((group) => {
      let sold = 0;
      let stock = 0;
      for (const [key, value] of group.exact) {
        if (key.endsWith("||M")) sold += value;
        if (key.endsWith("||S")) stock += value;
      }
      return sold < 0.5 && stock > 0.5;
    });
    for (const group of groups) {
      let value = 0;
      for (const [key, units] of group.exact) {
        if (!key.endsWith("||S")) continue;
        value += units * (unitPrice.get(key.split("||")[0]) ?? 0);
      }
      group.stockValue = value;
    }
  }
  return groups;
}

/** EGP per unit for each product, from what this scope actually sold it for. */
function unitPrices(rows: Split[]): Map<string, number> {
  const units = new Map<string, number>();
  const value = new Map<string, number>();
  for (const row of rows) {
    units.set(row.productCode, (units.get(row.productCode) ?? 0) + num(row.salesUnits));
    value.set(row.productCode, (value.get(row.productCode) ?? 0) + num(row.salesValue));
  }
  const out = new Map<string, number>();
  for (const [code, unitTotal] of units) {
    if (unitTotal > 0) out.set(code, (value.get(code) ?? 0) / unitTotal);
  }
  return out;
}

/** Biggest product first, ranked on the WHOLE scope — never on the tab being drawn (rule 3). */
/**
 * The product columns, in an order that does NOT depend on which slice of the line is in scope.
 *
 * Ranking by the value present in the rows made column N a different product in the district
 * manager's book than in the national one - the two are read side by side, and nothing on the page
 * says the axis moved. `axis` is the dashboard's stable product universe (scoped by week and
 * distributor only, never by the line, region or product filters), so every book built from one
 * sheet shares an order. A product in these rows but absent from the axis keeps the old value
 * ranking and sorts AFTER the axis, so nothing is ever dropped.
 */
export function orderedProducts(rows: Split[], axis?: string[]): { code: string; name: string }[] {
  const value = new Map<string, number>();
  const name = new Map<string, string>();
  for (const row of rows) {
    value.set(row.productCode, (value.get(row.productCode) ?? 0) + num(row.salesValue));
    if (!name.has(row.productCode)) name.set(row.productCode, row.productName || row.productCode);
  }
  const rank = new Map<string, number>();
  (axis ?? []).forEach((code, index) => {
    if (!rank.has(code)) rank.set(code, index);
  });
  const OFF_AXIS = Number.MAX_SAFE_INTEGER;
  return [...name.entries()]
    .map(([code, productName]) => ({ code, name: productName }))
    .sort((left, right) => {
      const leftRank = rank.get(left.code) ?? OFF_AXIS;
      const rightRank = rank.get(right.code) ?? OFF_AXIS;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return (value.get(right.code) ?? 0) - (value.get(left.code) ?? 0) || left.name.localeCompare(right.name);
    });
}

// ── the masthead ────────────────────────────────────────────────────────────────

const DAY_MONTH = (iso: string) => {
  const [, month, day] = iso.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(day)} ${names[Number(month) - 1] ?? month}`;
};

/** Short, recognisable distributor name for a header that must fit on one line. */
function shortDistributor(name: string): string {
  const trimmed = name.trim();
  if (/^pos/i.test(trimmed)) return "POS";
  if (/ibn\s*sina[-\s]*sato/i.test(trimmed)) return "Ibn Sina-Sato";
  if (/ibn\s*sina/i.test(trimmed)) return "Ibn Sina";
  if (/overseas/i.test(trimmed)) return "Overseas";
  return trimmed.split(/\s+/).slice(0, 2).join(" ");
}

type Upload = { name: string; weeks: number[]; latest: string; value: number };

function uploadsOf(rows: Split[]): Upload[] {
  const byDistributor = new Map<string, Upload>();
  for (const row of rows) {
    const name = row.distributorName || row.distributorCode;
    const upload = byDistributor.get(name) ?? { name, weeks: [], latest: "", value: 0 };
    if (row.weekNumber !== null && !upload.weeks.includes(row.weekNumber)) upload.weeks.push(row.weekNumber);
    if (row.weekStart > upload.latest) upload.latest = row.weekStart;
    upload.value += num(row.salesValue);
    byDistributor.set(name, upload);
  }
  for (const upload of byDistributor.values()) upload.weeks.sort((left, right) => left - right);
  return [...byDistributor.values()].sort((left, right) => right.latest.localeCompare(left.latest));
}

/**
 * The big date beside the title, and the caveats that make it mean something.
 *
 * "to 29 Aug · POS to 18 Aug" was shorthand and the owner could not read it (2026-08-30). Both
 * dates must still appear — his rule is that if there is more than one, all are named — but the
 * caveat now says WHY, because a distributor that stopped earlier can be most of the line and a
 * reader who misses that reads a short month as a bad month.
 */
export function dateHeadline(
  periodLabel: string,
  uploads: Upload[],
  weekNumbers: number[],
): { big: string; notes: string[] } {
  const byDate = new Map<string, Upload[]>();
  for (const upload of uploads) {
    if (!upload.latest) continue;
    byDate.set(upload.latest, [...(byDate.get(upload.latest) ?? []), upload]);
  }
  const dates = [...byDate.keys()].sort().reverse();
  if (dates.length === 0) return { big: periodLabel, notes: [] };

  let big = `${periodLabel}   ·   sales up to ${DAY_MONTH(dates[0])}`;
  for (const date of dates.slice(1)) {
    const names = (byDate.get(date) ?? []).map((upload) => shortDistributor(upload.name)).join(" & ");
    big += `   ·   ${names} only up to ${DAY_MONTH(date)}`;
  }

  const notes: string[] = [];
  const total = uploads.reduce((sum, upload) => sum + upload.value, 0);
  for (const date of dates.slice(1)) {
    for (const upload of byDate.get(date) ?? []) {
      const share = total > 0 ? (100 * upload.value) / total : 0;
      let note = `${shortDistributor(upload.name)} is ${share.toFixed(0)}% of this line and stops on ${DAY_MONTH(date)}, not ${DAY_MONTH(dates[0])}`;
      if (share >= 40) note += " - so most of this report is short by those days";
      notes.push(note);
    }
  }

  // Every week a distributor never sent. Its sales are not lost — they sit in the next week it DID
  // send, so that week is overstated and this one reads 0. A LATE FIRST SHEET is the same defect as
  // a gap in the middle and was invisible until POS started at W2.
  const carried = new Map<number, string[]>();
  for (const upload of uploads) {
    if (upload.weeks.length === 0) continue;
    for (const week of weekNumbers) {
      if (upload.weeks.includes(week)) continue;
      const next = upload.weeks.find((candidate) => candidate > week);
      if (next === undefined) continue;
      carried.set(week, [...(carried.get(week) ?? []), shortDistributor(upload.name)]);
    }
  }
  if (carried.size > 0) {
    const parts = [...carried.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([week, who]) => `W${week} reads 0 for ${who.join(" & ")}`);
    notes.push(`${parts.join(", ")} - no sheet came that week, so those sales sit in the week after`);
  }
  return { big, notes };
}

/** Which weeks this scope has, and the date(s) each of them was sent on. */
function weekLabels(rows: Split[]): { numbers: number[]; label: Map<number, string> } {
  const dates = new Map<number, Set<string>>();
  for (const row of rows) {
    if (row.weekNumber === null) continue;
    dates.set(row.weekNumber, (dates.get(row.weekNumber) ?? new Set()).add(row.weekStart));
  }
  const numbers = [...dates.keys()].sort((left, right) => left - right);
  const label = new Map<number, string>();
  for (const week of numbers) {
    const sorted = [...(dates.get(week) ?? new Set<string>())].sort();
    const span = sorted.length > 1 ? `${DAY_MONTH(sorted[0])}-${DAY_MONTH(sorted[sorted.length - 1])}` : DAY_MONTH(sorted[0]);
    label.set(week, `W${week}  ·  ${span}`);
  }
  return { numbers, label };
}

// ── drawing ─────────────────────────────────────────────────────────────────────

const GROUP_ROW = 5;
const HEADER_ROW = 6;
const FIRST_DATA_ROW = 7;

function paintMasthead(
  sheet: ExcelJS.Worksheet,
  columns: number,
  title: string,
  scopeLine: string,
  headline: { big: string; notes: string[] },
  extraNote: string | null,
): void {
  const widths: number[] = [];
  for (let column = 1; column <= columns; column += 1) widths.push(sheet.getColumn(column).width ?? 10);
  let total = widths.reduce((sum, value) => sum + value, 0);

  const stripParts = [systemIdentity.appName.toUpperCase(), scopeLine, ...headline.notes];
  if (extraNote) stripParts.push(extraNote);
  const strip = stripParts.join("   ·   ");

  // The strip carries the caveats, so it must stay READABLE. It shrinks only to 7.5pt; past that
  // the LAST column is widened to make room instead. A 6.5pt explanation explains nothing.
  let stripSize = 8.5;
  while (stripSize > 7.5 && widthOf(strip, stripSize) > total) stripSize -= 0.5;
  if (widthOf(strip, stripSize) > total) {
    const grow = widthOf(strip, stripSize) - total;
    sheet.getColumn(columns).width = Math.round((widths[columns - 1] + grow) * 10) / 10;
    widths[columns - 1] += grow;
    total += grow;
  }

  sheet.mergeCells(1, 1, 1, columns);
  const stripCell = sheet.getCell(1, 1);
  stripCell.value = strip;
  stripCell.font = { name: "Calibri", size: stripSize, bold: true, color: { argb: SUB } };
  stripCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(1).height = 14;

  // Title on the left, the big date on the right, at the SAME size — the owner asked for the date
  // to be as big as the title, and for every date to be named when there is more than one.
  let titleSize = 18;
  const needed = () => widthOf(title, titleSize) + widthOf(headline.big, titleSize);
  while (titleSize > 11 && needed() > total) titleSize -= 0.5;

  const titleCell = sheet.getCell(2, 1);
  titleCell.value = title;
  titleCell.font = { name: "Calibri", size: titleSize, bold: true, color: { argb: INK } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // The date needs enough merged columns to render at full size without clipping.
  let dateFirst = columns;
  let span = widths[columns - 1];
  const want = widthOf(headline.big, titleSize);
  while (dateFirst > 2 && span < want) {
    dateFirst -= 1;
    span += widths[dateFirst - 1];
  }
  if (dateFirst > 1) {
    sheet.mergeCells(2, dateFirst, 2, columns);
    const dateCell = sheet.getCell(2, dateFirst);
    dateCell.value = headline.big;
    dateCell.font = { name: "Calibri", size: titleSize, bold: false, color: { argb: ACCENT } };
    dateCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
  }
  sheet.getRow(2).height = Math.round(titleSize * 1.9);

  for (let column = 1; column <= columns; column += 1) {
    sheet.getCell(3, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
  }
  sheet.getRow(3).height = 3;
  sheet.getRow(4).height = 6;
}

/** Fit every column to the widest string actually rendered in it. openpyxl-style measurement:
 *  there is no autofit in the file format, so the width has to be computed from the text. */
function autofit(
  sheet: ExcelJS.Worksheet,
  columns: number,
  fromRow: number,
  toRow: number,
  floor: Map<number, number>,
  cap = 44,
): void {
  for (let column = 1; column <= columns; column += 1) {
    let widest = floor.get(column) ?? 0;
    for (let row = fromRow; row <= toRow; row += 1) {
      const cell = sheet.getCell(row, column);
      if (cell.isMerged && cell.master !== cell) continue;
      const raw = cell.value;
      if (raw === null || raw === undefined) continue;
      let text: string;
      if (typeof raw === "number") text = Math.round(raw).toLocaleString("en-US");
      else if (typeof raw === "object" && raw !== null && "formula" in raw) text = "0,000,000";
      else text = String(raw);
      const size = Number(cell.font?.size ?? 10);
      widest = Math.max(widest, widthOf(text, size) * 1.02);
    }
    sheet.getColumn(column).width = Math.round(Math.min(Math.max(widest, 6), cap) * 10) / 10;
  }
}

function styleHeader(cell: ExcelJS.Cell, right: boolean, soft = false): void {
  cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: soft ? HEAD_SOFT : HEAD } };
  cell.alignment = { vertical: "middle", horizontal: right ? "right" : "left", indent: 1 };
  cell.border = {
    top: { style: "thin", color: { argb: RULE_STRONG } },
    bottom: { style: "thin", color: { argb: RULE_STRONG } },
  };
}

// ── sheet builders ──────────────────────────────────────────────────────────────

type SheetContext = {
  input: NsmDsmWorkbookInput;
  rows: Split[];
  products: { code: string; name: string }[];
  weekNumbers: number[];
  weekLabel: Map<number, string>;
  headline: { big: string; notes: string[] };
  scopeLine: string;
  unitPrice: Map<string, number>;
  targets: Map<string, number>;
  /** Set when the product-by-week grid would be too wide to read; the weeks are then dropped. */
  weeksDropped: boolean;
};

function measuresForTab(tab: TabKey, context: SheetContext): { key: Measure; label: string }[] {
  if (tab === "ranked") return [{ key: "M", label: "Month" }];
  if (tab === "stock") return [{ key: "S", label: "Stock" }];
  if (tab === "details") return [
    { key: "M", label: "Month" },
    { key: "S", label: "Stock" },
  ];
  const out = context.weeksDropped
    ? []
    : context.weekNumbers.map((week) => ({ key: `W${week}` as Measure, label: context.weekLabel.get(week) ?? `W${week}` }));
  out.push({ key: "M", label: "Month" });
  return out;
}

function drawFlatSheet(workbook: ExcelJS.Workbook, tab: TabKey, context: SheetContext, sheetPrefix: string): void {
  const { input, products } = context;
  const sheet = workbook.addWorksheet(sanitizeSheetName(`${sheetPrefix}${TAB_SHEET[tab]}`).slice(0, 31));
  sheet.views = [{ showGridLines: false }];

  const idColumns = ID_COLUMNS[tab];
  const measures = measuresForTab(tab, context);
  const groups = buildGroups(input, context.rows, tab, context.weekNumbers, context.unitPrice);

  const keys: string[] = [];
  for (const product of products) {
    for (const measure of measures) {
      if (measure.key !== "M") keys.push(cellKey(product.code, measure.key));
    }
  }
  roundColumns(groups, keys, tab === "stock" ? null : context.targets);
  // The month is not rounded on its own — it is the sum of the weeks actually printed beside it, so
  // a reader adding W1..Wn across a row always lands on the Month next to it (rule 2).
  if (measures.some((measure) => measure.key === "M") && !context.weeksDropped && tab !== "ranked" && tab !== "details") {
    for (const group of groups) {
      for (const product of products) {
        let sum = 0;
        for (const week of context.weekNumbers) sum += group.print.get(cellKey(product.code, `W${week}`)) ?? 0;
        group.print.set(cellKey(product.code, "M"), sum);
      }
    }
  } else {
    for (const group of groups) {
      for (const product of products) {
        for (const measure of measures) {
          const key = cellKey(product.code, measure.key);
          if (!group.print.has(key)) group.print.set(key, Math.round(group.exact.get(key) ?? 0));
        }
      }
    }
  }

  if (tab === "ranked") groups.sort((left, right) => right.value - left.value);
  else if (tab === "stock") groups.sort((left, right) => right.stockValue - left.stockValue);
  else groups.sort((left, right) => right.value - left.value);

  const valueLabel = tab === "stock" ? "Stock value (EGP)" : "Sales Value (EGP)";
  const columns = idColumns.length + products.length * measures.length + 1;

  // Row 5: the product band, merged over that product's own columns.
  const spans: { name: string; from: number; to: number }[] = [];
  let cursor = idColumns.length + 1;
  for (const product of products) {
    const from = cursor;
    const to = cursor + measures.length - 1;
    spans.push({ name: product.name, from, to });
    if (to > from) sheet.mergeCells(GROUP_ROW, from, GROUP_ROW, to);
    const cell = sheet.getCell(GROUP_ROW, from);
    cell.value = product.name;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "thin", color: { argb: RULE_STRONG } } };
    for (let column = from; column <= to; column += 1) {
      sheet.getCell(GROUP_ROW, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_SOFT } };
    }
    cursor = to + 1;
  }
  sheet.getCell(GROUP_ROW, columns).value = valueLabel;
  styleHeader(sheet.getCell(GROUP_ROW, columns), true, true);

  // Row 6: the header.
  idColumns.forEach((label, index) => {
    const cell = sheet.getCell(HEADER_ROW, index + 1);
    cell.value = label;
    styleHeader(cell, false);
  });
  cursor = idColumns.length + 1;
  for (let index = 0; index < products.length; index += 1) {
    for (const measure of measures) {
      const cell = sheet.getCell(HEADER_ROW, cursor);
      cell.value = measure.label;
      styleHeader(cell, true);
      cursor += 1;
    }
  }
  const totalHeader = sheet.getCell(HEADER_ROW, columns);
  totalHeader.value = "Total";
  styleHeader(totalHeader, true);

  // Data.
  let row = FIRST_DATA_ROW;
  groups.forEach((group, index) => {
    const zebra = index % 2 === 1;
    idColumns.forEach((label, position) => {
      const cell = sheet.getCell(row, position + 1);
      cell.value = group.id[label] ?? "";
      cell.font = { name: "Calibri", size: 10, bold: position === 0, color: { argb: position === 0 ? INK : SUB } };
      cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    });
    let column = idColumns.length + 1;
    for (const product of products) {
      for (const measure of measures) {
        const cell = sheet.getCell(row, column);
        const value = group.print.get(cellKey(product.code, measure.key)) ?? 0;
        cell.value = value;
        cell.numFmt = F_UNITS;
        cell.font = {
          name: "Calibri",
          size: 10,
          bold: measure.key === "M" && measures.length > 1,
          color: { argb: value === 0 ? FAINT : INK },
        };
        cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
        column += 1;
      }
    }
    const totalCell = sheet.getCell(row, columns);
    totalCell.value = Math.round(tab === "stock" ? group.stockValue : group.value);
    totalCell.numFmt = F_VALUE;
    totalCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    totalCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };

    if (zebra) {
      for (let column2 = 1; column2 <= columns; column2 += 1) {
        sheet.getCell(row, column2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
      }
    }
    row += 1;
  });

  // A SUBTOTAL total row, so filtering the sheet recomputes it over what is visible.
  const lastData = row - 1;
  if (lastData >= FIRST_DATA_ROW) {
    const totalRow = sheet.getCell(row, 1);
    totalRow.value = "Total (rows shown)";
    totalRow.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    totalRow.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    for (let column = idColumns.length + 1; column <= columns; column += 1) {
      const letter = sheet.getColumn(column).letter;
      const cell = sheet.getCell(row, column);
      cell.value = { formula: `SUBTOTAL(109,${letter}${FIRST_DATA_ROW}:${letter}${lastData})` };
      cell.numFmt = column === columns ? F_VALUE : F_UNITS;
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
      cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    }
    for (let column = 1; column <= columns; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
      cell.border = { top: { style: "thin", color: { argb: RULE_STRONG } } };
    }
    sheet.autoFilter = {
      from: { row: HEADER_ROW, column: 1 },
      to: { row: lastData, column: columns },
    };
  }

  // A merged band name can be wider than the columns beneath it, and autofit never measures a
  // merged cell — so give the product's LAST column whatever the name still needs.
  const floor = new Map<number, number>();
  autofit(sheet, columns, HEADER_ROW, row, floor);
  for (const span of spans) {
    let have = 0;
    for (let column = span.from; column <= span.to; column += 1) have += sheet.getColumn(column).width ?? 0;
    const need = widthOf(span.name, 10) * 1.06;
    if (have < need) {
      const last = sheet.getColumn(span.to);
      last.width = Math.round(((last.width ?? 0) + (need - have)) * 10) / 10;
    }
  }

  let extraNote: string | null = null;
  if (tab === "stock") {
    const reporting = [...new Set(groups.map((group) => group.id.Distributor))].sort();
    extraNote = reporting.length > 0
      ? `stock shows only for distributors that send one - ${reporting.join(", ")} do`
      : "no distributor in this scope reports stock on hand";
  }
  if (context.weeksDropped && (tab === "area" || tab === "branch" || tab === "dist")) {
    extraNote = `${context.products.length} products x ${context.weekNumbers.length} weeks is too wide to read, so the week columns are not shown here - filter to one line for the weekly grid`;
  }
  paintMasthead(sheet, columns, TAB_TITLE[tab], context.scopeLine, context.headline, extraNote);

  sheet.views = [
    { state: "frozen", xSplit: idColumns.length, ySplit: HEADER_ROW, showGridLines: false },
  ];
  applyPrint(sheet, columns, row);
}

function drawSummarySheet(workbook: ExcelJS.Workbook, context: SheetContext, sheetPrefix: string): void {
  const { input, products } = context;
  const sheet = workbook.addWorksheet(sanitizeSheetName(`${sheetPrefix}Summary`).slice(0, 31));
  sheet.views = [{ showGridLines: false }];

  const measures = measuresForTab("area", context);
  const areaGroups = buildGroups(input, context.rows, "area", context.weekNumbers, context.unitPrice);
  const keys: string[] = [];
  for (const product of products) {
    for (const measure of measures) if (measure.key !== "M") keys.push(cellKey(product.code, measure.key));
  }
  roundColumns(areaGroups, keys, context.targets);
  for (const group of areaGroups) {
    for (const product of products) {
      let sum = 0;
      for (const week of context.weekNumbers) sum += group.print.get(cellKey(product.code, `W${week}`)) ?? 0;
      group.print.set(cellKey(product.code, "M"), sum);
    }
  }

  const columns = 1 + measures.length + 2;

  // "The line at a glance": one row per product, read off the SAME printed numbers the region
  // tables below use, so the two can never disagree.
  let row = GROUP_ROW;
  const glance = sheet.getCell(row, 1);
  glance.value = "The line at a glance";
  glance.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } };
  row += 1;

  const headerRow = row;
  const headers = ["Product", ...measures.map((measure) => measure.label), "Sales Value (EGP)", "Share of line"];
  headers.forEach((label, index) => styleHeaderWith(sheet, headerRow, index + 1, label, index > 0));
  row += 1;

  const productValue = new Map<string, number>();
  for (const source of context.rows) {
    productValue.set(source.productCode, (productValue.get(source.productCode) ?? 0) + num(source.salesValue));
  }
  const lineValue = [...productValue.values()].reduce((sum, value) => sum + value, 0);

  products.forEach((product, index) => {
    const cell = sheet.getCell(row, 1);
    cell.value = product.name;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    measures.forEach((measure, position) => {
      let sum = 0;
      for (const group of areaGroups) sum += group.print.get(cellKey(product.code, measure.key)) ?? 0;
      const numberCell = sheet.getCell(row, position + 2);
      numberCell.value = sum;
      numberCell.numFmt = F_UNITS;
      numberCell.font = { name: "Calibri", size: 10, bold: measure.key === "M", color: { argb: sum === 0 ? FAINT : INK } };
      numberCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    });
    const valueCell = sheet.getCell(row, measures.length + 2);
    valueCell.value = Math.round(productValue.get(product.code) ?? 0);
    valueCell.numFmt = F_VALUE;
    valueCell.font = { name: "Calibri", size: 10, color: { argb: INK } };
    valueCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    const shareCell = sheet.getCell(row, measures.length + 3);
    shareCell.value = lineValue > 0 ? (productValue.get(product.code) ?? 0) / lineValue : 0;
    shareCell.numFmt = F_PCT;
    shareCell.font = { name: "Calibri", size: 10, color: { argb: INK } };
    shareCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    if (index % 2 === 1) {
      for (let column = 1; column <= columns; column += 1) {
        sheet.getCell(row, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
      }
    }
    row += 1;
  });

  // One table per region, areas down the side. Products across, in the LINE's order.
  const byRegion = new Map<string, Group[]>();
  for (const group of areaGroups) {
    byRegion.set(group.region, [...(byRegion.get(group.region) ?? []), group]);
  }
  const regionValue = (list: Group[]) => list.reduce((sum, group) => sum + group.value, 0);
  const regions = [...byRegion.entries()].sort((left, right) => regionValue(right[1]) - regionValue(left[1]));

  for (const [region, list] of regions) {
    row += 1;
    const heading = sheet.getCell(row, 1);
    heading.value = region;
    heading.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } };
    heading.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    const headingValue = sheet.getCell(row, measures.length + 2);
    headingValue.value = Math.round(regionValue(list));
    headingValue.numFmt = F_VALUE;
    headingValue.font = { name: "Calibri", size: 11, bold: true, color: { argb: ACCENT } };
    headingValue.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    row += 1;

    const areaHeader = ["Area", ...products.map((product) => product.name), "Sales Value (EGP)"];
    areaHeader.forEach((label, index) => styleHeaderWith(sheet, row, index + 1, label, index > 0));
    row += 1;

    const sorted = list.slice().sort((left, right) => right.value - left.value);
    sorted.forEach((group, index) => {
      const cell = sheet.getCell(row, 1);
      cell.value = group.id.Area ?? "";
      cell.font = { name: "Calibri", size: 10, color: { argb: INK } };
      cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      products.forEach((product, position) => {
        const value = group.print.get(cellKey(product.code, "M")) ?? 0;
        const numberCell = sheet.getCell(row, position + 2);
        numberCell.value = value;
        numberCell.numFmt = F_UNITS;
        numberCell.font = { name: "Calibri", size: 10, color: { argb: value === 0 ? FAINT : INK } };
        numberCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
      });
      const valueCell = sheet.getCell(row, products.length + 2);
      valueCell.value = Math.round(group.value);
      valueCell.numFmt = F_VALUE;
      valueCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
      valueCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
      if (index % 2 === 1) {
        for (let column = 1; column <= Math.max(columns, products.length + 2); column += 1) {
          sheet.getCell(row, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
        }
      }
      row += 1;
    });

    const totalCell = sheet.getCell(row, 1);
    totalCell.value = `${region} - total`;
    totalCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    totalCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    products.forEach((product, position) => {
      let sum = 0;
      for (const group of list) sum += group.print.get(cellKey(product.code, "M")) ?? 0;
      const cell = sheet.getCell(row, position + 2);
      cell.value = sum;
      cell.numFmt = F_UNITS;
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
      cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    });
    const regionTotal = sheet.getCell(row, products.length + 2);
    regionTotal.value = Math.round(regionValue(list));
    regionTotal.numFmt = F_VALUE;
    regionTotal.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    regionTotal.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    for (let column = 1; column <= Math.max(columns, products.length + 2); column += 1) {
      const cell = sheet.getCell(row, column);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
      cell.border = { top: { style: "thin", color: { argb: RULE } } };
    }
    row += 1;
  }

  const wide = Math.max(columns, products.length + 2);
  autofit(sheet, wide, headerRow, row, new Map());
  paintMasthead(sheet, wide, "Summary", context.scopeLine, context.headline, null);
  // No frozen pane: this sheet stacks several tables, so a pane frozen at the first table's header
  // is meaningless everywhere below it.
  sheet.views = [{ showGridLines: false }];
  applyPrint(sheet, wide, row);
}

function styleHeaderWith(sheet: ExcelJS.Worksheet, row: number, column: number, label: string, right: boolean): void {
  const cell = sheet.getCell(row, column);
  cell.value = label;
  styleHeader(cell, right);
}

function applyPrint(sheet: ExcelJS.Worksheet, columns: number, lastRow: number): void {
  try {
    sheet.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      printTitlesRow: `1:${HEADER_ROW}`,
      // printArea is a member of ExcelJS's PageSetup, NOT of Worksheet. Assigning sheet.printArea
      // works at runtime — ExcelJS proxies it — but does not typecheck, which is what turned the
      // PR's typecheck job red.
      printArea: `A1:${sheet.getColumn(columns).letter}${Math.max(lastRow, 1)}`,
    };
  } catch {
    // Print setup is polish — never fail an export over it.
  }
}

// ── entry point ─────────────────────────────────────────────────────────────────

const normalizeLine = (value: string) => value.trim();

/**
 * Build the NSM/DSM workbook for the viewer's current filters.
 *
 * When several lines are in scope the workbook splits into one tab set per line, the same rule the
 * Summarized Report follows — the product axis is per line, so mixing lines makes the weekly grid
 * both wider and meaningless.
 */
export async function buildNsmDsmWorkbook(input: NsmDsmWorkbookInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  const all = explode(input, input.rows);
  const picked = [...new Set(input.lineFilter.map(normalizeLine).filter(Boolean))];
  const lines = picked.length > 1 ? picked : [];

  if (lines.length === 0) {
    buildTabSet(workbook, input, all, "", picked.length === 1 ? picked[0] : null);
  } else {
    for (const line of lines) {
      const forLine = all.filter((row) => row.line.trim().toLowerCase() === line.trim().toLowerCase());
      if (forLine.length === 0) continue;
      buildTabSet(workbook, input, forLine, `${line} - `, line);
    }
  }

  if (workbook.worksheets.length === 0) {
    const sheet = workbook.addWorksheet("Summary");
    sheet.getCell(2, 1).value = "No weekly sales rows match these filters.";
    sheet.getCell(2, 1).font = { name: "Calibri", size: 12, bold: true, color: { argb: INK } };
    sheet.getColumn(1).width = 60;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * The masthead's "who is reading this" phrase: a NAME beside the role they hold, then the scope.
 *
 * The seat is often vacant, and when it is there is no name to print. Falling back to the role
 * string in the name's slot produced "National Sales Manager - National Sales Manager, all
 * regions" — the role stated twice, which reads as a bug in the report and makes a reader doubt
 * the numbers under it. With no name, the role is stated ONCE and the scope still says who the
 * book is for.
 */
export function scopeWho(name: string | null, role: string, scope: string): string {
  const named = (name ?? "").trim();
  return named && named !== role ? `${named} - ${role}, ${scope}` : `${role}, ${scope}`;
}

function buildTabSet(
  workbook: ExcelJS.Workbook,
  input: NsmDsmWorkbookInput,
  rows: Split[],
  sheetPrefix: string,
  lineLabel: string | null,
): void {
  const products = orderedProducts(rows, input.productAxis);
  const { numbers: weekNumbers, label: weekLabel } = weekLabels(rows);
  const uploads = uploadsOf(rows);
  const headline = dateHeadline(input.periodLabel, uploads, weekNumbers);

  // Who is reading this. One region in scope reads as that district's book and names its manager;
  // anything wider is the line's book and names the national manager above them.
  // Whose book this is. The REQUEST decides: asking for one region makes this that district's book
  // even when splitting a depot across the areas it serves spills a little value into a neighbour,
  // which is routine on depot data. Reading it off the rows instead silently promoted a district's
  // book to "all regions" and printed the NATIONAL manager's name over his own numbers.
  const requestedRegions = (input.regionFilter ?? []).filter(Boolean);
  const regions =
    requestedRegions.length === 1
      ? [input.regionNames.get(requestedRegions[0].trim().toUpperCase()) ?? requestedRegions[0]]
      : [...new Set(rows.map((row) => regionOf(input, row)))];
  const sample = rows[0];
  const bucket = sample
    ? resolveWeeklyManager(input.managerIndex, sample.line, sample.regionCode, sample.areaCode)
    : null;
  const who =
    regions.length === 1
      ? scopeWho(bucket?.managerName ?? null, "District Manager", `${regions[0]} only`)
      : scopeWho(bucket?.nsmName ?? null, "National Sales Manager", "all regions");
  const scopeLine = [lineLabel ? lineLabel.toUpperCase() : "ALL TRACKED LINES", who].join("   ·   ");

  // A product-by-week grid wider than ~120 columns cannot be read on paper. Drop the weeks rather
  // than the products, and SAY SO on the sheet — a silent cut reads as "this is everything".
  const weeksDropped = products.length * (weekNumbers.length + 1) > 120;

  const context: SheetContext = {
    input,
    rows,
    products,
    weekNumbers,
    weekLabel,
    headline,
    scopeLine,
    unitPrice: unitPrices(rows),
    targets: lineTargetsFor(rows, weekNumbers, input),
    weeksDropped,
  };

  drawSummarySheet(workbook, context, sheetPrefix);
  for (const tab of ["area", "branch", "dist", "ranked", "stock", "details"] as TabKey[]) {
    drawFlatSheet(workbook, tab, context, sheetPrefix);
  }
}
