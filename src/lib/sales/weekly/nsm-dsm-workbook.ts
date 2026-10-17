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
import { weeklyHoldsStockWithNoSales, type WeeklyProductMovement } from "@/lib/sales/weekly/unit-totals";

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
// The only colours in this book that carry MEANING rather than structure, so they are the only ones
// allowed to be seen from across a desk. Everything else is ink, rule and paper.
const UP = "FF1E7A3C";
const DOWN = "FFB3261E";
const HEAT_TOP = "FFF6DCC4";
const HEAT_MID = "FFFBEFE2";

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
  /**
   * Whose book this is when the CALLER already knows the reader's seat, rather than inferring it
   * from how many regions the rows span. The portal download is taken by one named manager and is
   * already narrowed to his own scope, so his own seat names the masthead: a regional manager
   * covering three regions used to be handed a book headed with the NATIONAL manager's name.
   * Omitted on the admin export, which keeps the region-count rule unchanged.
   */
  viewerSeat?: "nsm" | "rsm";
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
  /**
   * product code -> EGP this group sold of it. It PARTITIONS `value` exactly, which is what lets
   * the Ranked tab print family totals beside the row total and have the two agree.
   */
  valueByProduct: Map<string, number>;
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
        valueByProduct: new Map(),
        stockValue: 0,
      };
      byKey.set(key, group);
    }
    for (const measure of measuresOf(row, weekNumbers)) {
      const cell = cellKey(row.productCode, measure.measure);
      group.exact.set(cell, (group.exact.get(cell) ?? 0) + measure.units);
    }
    group.value += num(row.salesValue);
    group.valueByProduct.set(
      row.productCode,
      (group.valueByProduct.get(row.productCode) ?? 0) + num(row.salesValue),
    );
  }

  let groups = [...byKey.values()];

  if (tab === "stock") {
    // Branches holding stock that sold NOTHING this period, on the EXACT floats, before rounding —
    // and PRODUCT BY PRODUCT (weeklyHoldsStockWithNoSales). Units of different products are never
    // added, so one product's returns can no longer cancel another product's sales and put a branch
    // that is selling on a sheet whose whole point is that these branches sold nothing.
    groups = groups.filter((group) => {
      const products = new Map<string, WeeklyProductMovement>();
      for (const [key, value] of group.exact) {
        const split = key.lastIndexOf("||");
        const measure = key.slice(split + 2);
        if (measure !== "M" && measure !== "S") continue;
        const productCode = key.slice(0, split);
        const product = products.get(productCode) ?? { netUnits: 0, stockUnits: 0 };
        if (measure === "M") product.netUnits += value;
        else product.stockUnits += value;
        products.set(productCode, product);
      }
      return weeklyHoldsStockWithNoSales(products.values());
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

/**
 * The product columns grouped into FAMILIES, in the axis order (rule 3 again).
 *
 * A family is the owner's unit of thought - "how did Conviban do here" - but its four
 * concentrations cannot be added in units, so a family line is always MONEY. Grouping is on the
 * family NAME: family_code is not unique in this master ("DO" is both Dopaminict and Dolabactin),
 * and Lacto Advanced and Lacto Basic still SHARE the code `LA` - deliberately, because that is
 * what lets one direct order carry both Advanced concentrations (direct-orders/product-family.ts
 * allow-lists exactly that code). Their family NAMES were separated on 2026-08-31 - Pedia reads
 * "Lacto Advanced" and Head Office "Lacto Basic" - so the NAME is the half of the pair that
 * discriminates, and grouping on it can no longer weld a Head Office product into a Pedia family.
 * Do not "tidy" the codes to match the names: that would silently un-combine the direct order.
 * A product the master gave no family stands as its own one-product family rather than being
 * collected into an "Other" bin, which would put unrelated products under a single money total.
 */
export function familyBlocks(
  products: { code: string; name: string }[],
  familyOf: Map<string, string>,
): { name: string; products: { code: string; name: string }[] }[] {
  const order: string[] = [];
  const bins = new Map<string, { code: string; name: string }[]>();
  for (const product of products) {
    const family = (familyOf.get(product.code) ?? "").trim() || product.name;
    const bin = bins.get(family);
    if (bin) bin.push(product);
    else {
      bins.set(family, [product]);
      order.push(family);
    }
  }
  return order.map((name) => ({ name, products: bins.get(name) ?? [] }));
}

/**
 * The two weeks a trend arrow compares - NOT simply the last two.
 *
 * A week a distributor never sent reads 0 here and its sales sit in the next week that did arrive;
 * the masthead says exactly that, in plain English. Comparing against that 0 would paint a green
 * arrow on every row of the recovery week and a red one on every row of the gap. So the pair is
 * drawn only from weeks carrying money ACROSS THE WHOLE SHEET - the set that note is about.
 */
export function trendPair(valueByWeek: Map<number, number>): { last: number; prev: number } | null {
  const live = [...valueByWeek.entries()]
    .filter(([, value]) => value > 0)
    .map(([week]) => week)
    .sort((left, right) => left - right);
  if (live.length < 2) return null;
  return { last: live[live.length - 1], prev: live[live.length - 2] };
}

/** Up, down, or nothing. A row that sold in NEITHER week gets no arrow, never a flat one. */
export function trendMark(last: number, prev: number): { glyph: string; colour: string } | null {
  if (last <= 0 && prev <= 0) return null;
  if (last > prev) return { glyph: "▲", colour: UP };
  if (last < prev) return { glyph: "▼", colour: DOWN };
  return null;
}

/**
 * The distributors whose two weeks can honestly be compared: the ones that sent a sheet in BOTH.
 *
 * Skipping weeks that are empty sheet-wide is not enough on real data. In August, Ibn Sina - 30% of
 * the line - sent nothing in W3, so W3 was low but not zero, and every row on the sheet then read as
 * a rise: 47 up against 1 down on the area tab. That is not a trend, it is a filing gap wearing a
 * green arrow, and it is worse than no arrow at all because it looks like information.
 */
export function comparableDistributors(
  rows: { distributorCode: string; weekNumber: number | null; salesValue: number }[],
  last: number,
  prev: number,
): Set<string> {
  const inLast = new Set<string>();
  const inPrev = new Set<string>();
  for (const row of rows) {
    if (num(row.salesValue) <= 0) continue;
    if (row.weekNumber === last) inLast.add(row.distributorCode);
    if (row.weekNumber === prev) inPrev.add(row.distributorCode);
  }
  const both = new Set<string>();
  for (const code of inLast) if (inPrev.has(code)) both.add(code);
  return both;
}

/**
 * Each group's money in the two compared weeks, counting only the comparable distributors.
 *
 * Keyed exactly as `buildGroups` keys its groups, so a row looks its own pair up by its own id.
 */
function trendByGroup(
  input: NsmDsmWorkbookInput,
  rows: Split[],
  tab: TabKey,
  trend: { last: number; prev: number },
  comparable: Set<string>,
): Map<string, { last: number; prev: number }> {
  const out = new Map<string, { last: number; prev: number }>();
  for (const row of rows) {
    if (row.weekNumber !== trend.last && row.weekNumber !== trend.prev) continue;
    if (!comparable.has(row.distributorCode)) continue;
    const id = idOf(input, row, tab);
    const key = ID_COLUMNS[tab].map((column) => id[column]).join("||");
    let pair = out.get(key);
    if (!pair) {
      pair = { last: 0, prev: 0 };
      out.set(key, pair);
    }
    if (row.weekNumber === trend.last) pair.last += num(row.salesValue);
    else pair.prev += num(row.salesValue);
  }
  return out;
}

/**
 * Whether a row gained or lost GROUND between the two weeks - not whether its money went up.
 *
 * Measured on live August CNS: the W4 sheet carried 1,374,341 EGP against W3's 342,712, a factor of
 * four. That gap is when the distributors' sheets arrived, not how anyone sold, and against it a
 * plain money comparison marked 44 areas up and 1 down - a column of green that a manager cannot
 * act on, because it says the same thing about every row. Dividing by the line removes the part
 * that is common to everybody and leaves the part that is about this row: whose slice grew.
 *
 * Both weeks are counted over the SAME distributors (see `comparableDistributors`), so the divisor
 * is not itself distorted by a house that skipped a week.
 */
export function shareTrend(
  pair: { last: number; prev: number },
  lineLast: number,
  linePrev: number,
): { glyph: string; colour: string } | null {
  if (lineLast <= 0 || linePrev <= 0) return null;
  return trendMark(pair.last / lineLast, pair.prev / linePrev);
}

/** The key `buildGroups` filed a group under, rebuilt from the group's own printed ids. */
const groupKey = (group: Group, tab: TabKey) => ID_COLUMNS[tab].map((column) => group.id[column]).join("||");

/**
 * Round a list of money figures to whole EGP so they still add to `target` exactly.
 *
 * Deliberately NOT `conserveRound`: that one distributes whole UNITS and never takes a cell below
 * zero, which is right for units and wrong here - a family carrying returns is legitimately
 * negative. The residue is at most half an EGP per family, and it lands on the largest family,
 * where it cannot be seen.
 */
export function shareOut(values: number[], target: number): number[] {
  const out = values.map((value) => Math.round(value));
  const drift = target - out.reduce((sum, value) => sum + value, 0);
  if (drift !== 0 && out.length > 0) {
    let pick = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (Math.abs(values[index]) > Math.abs(values[pick])) pick = index;
    }
    out[pick] += drift;
  }
  return out;
}

/** One line saying what the arrows mean, because a mark nobody can read is worse than no mark. */
const arrowNote = (trend: { last: number; prev: number }) =>
  `green up / red down is this row's SHARE of the line, W${trend.prev} to W${trend.last} - two weekly sheets are rarely the same size, so plain money would mostly measure which sheets arrived`;

/** Add ONE vertical rule to a cell without discarding the borders it already carries. */
function addSide(cell: ExcelJS.Cell, side: "left" | "right"): void {
  cell.border = { ...(cell.border ?? {}), [side]: { style: "thin", color: { argb: RULE_STRONG } } };
}

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
  /** The UNSPLIT rows for this line. Stock lives at a physical branch, so the Stock-by-branch
   *  sheet must not read the pro-rata area split that is correct for sales. */
  rawRows: WeeklyFactExportRow[];
  products: { code: string; name: string }[];
  weekNumbers: number[];
  weekLabel: Map<number, string>;
  headline: { big: string; notes: string[] };
  scopeLine: string;
  unitPrice: Map<string, number>;
  targets: Map<string, number>;
  /** product code -> family NAME from the master. Empty when the master has none for it. */
  familyOf: Map<string, string>;
  /** The two weeks the arrow column compares, or null when fewer than two weeks carry money. */
  trend: { last: number; prev: number } | null;
  /** Distributors that sent a sheet in BOTH of those weeks - the only ones an arrow may count. */
  trendDistributors: Set<string>;
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
  const totalColumn = idColumns.length + products.length * measures.length + 1;
  // The arrow column, only where a direction can honestly be drawn. The Stock tab is branches that
  // sold NOTHING, so an arrow there would be a claim about nothing.
  const trend = tab === "stock" ? null : context.trend;
  const trendColumn = trend ? totalColumn + 1 : 0;
  const columns = trend ? trendColumn : totalColumn;
  const trendPairs = trend
    ? trendByGroup(input, context.rows, tab, trend, context.trendDistributors)
    : new Map<string, { last: number; prev: number }>();
  let trendLineLast = 0;
  let trendLinePrev = 0;
  for (const pair of trendPairs.values()) {
    trendLineLast += pair.last;
    trendLinePrev += pair.prev;
  }

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
  sheet.getCell(GROUP_ROW, totalColumn).value = valueLabel;
  styleHeader(sheet.getCell(GROUP_ROW, totalColumn), true, true);
  if (trend) {
    const band = sheet.getCell(GROUP_ROW, trendColumn);
    band.value = "Trend";
    styleHeader(band, true, true);
  }

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
  const totalHeader = sheet.getCell(HEADER_ROW, totalColumn);
  totalHeader.value = "Total";
  styleHeader(totalHeader, true);
  if (trend) {
    const head = sheet.getCell(HEADER_ROW, trendColumn);
    // The header names the two weeks, so the arrow needs no legend and nobody has to be told.
    head.value = `Share W${trend.last} vs W${trend.prev}`;
    styleHeader(head, true);
  }

  // Data.
  const heat: { row: number; value: number }[] = [];
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
          // A return reads as a negative unit count. It is the one figure on the grid that says
          // something went the wrong way, so it is the one figure that is not black.
          color: { argb: value === 0 ? FAINT : value < 0 ? DOWN : INK },
        };
        cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
        column += 1;
      }
    }
    const totalCell = sheet.getCell(row, totalColumn);
    const totalValue = Math.round(tab === "stock" ? group.stockValue : group.value);
    totalCell.value = totalValue;
    totalCell.numFmt = F_VALUE;
    totalCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    totalCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    heat.push({ row, value: totalValue });

    if (trend) {
      const pair = trendPairs.get(groupKey(group, tab));
      const mark = pair ? shareTrend(pair, trendLineLast, trendLinePrev) : null;
      const arrow = sheet.getCell(row, trendColumn);
      arrow.value = mark ? mark.glyph : "";
      arrow.font = { name: "Calibri", size: 8, bold: true, color: { argb: mark ? mark.colour : FAINT } };
      arrow.alignment = { vertical: "middle", horizontal: "center" };
    }

    if (zebra) {
      for (let column2 = 1; column2 <= columns; column2 += 1) {
        sheet.getCell(row, column2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
      }
    }
    row += 1;
  });

  // WHERE TO LOOK. One column carries a tint, and only by size: the rows holding the top tenth of
  // the money, then the next fifth a shade fainter. Applied after the zebra so it sits over it, and
  // deliberately nowhere else - a sheet where several things are coloured is a sheet where the eye
  // has to choose, which is the opposite of the point.
  const byMoney = heat.filter((entry) => entry.value > 0).sort((left, right) => right.value - left.value);
  const topEnd = Math.max(1, Math.round(byMoney.length * 0.1));
  const softEnd = Math.max(topEnd, Math.round(byMoney.length * 0.3));
  const strongRows = new Set(byMoney.slice(0, topEnd).map((entry) => entry.row));
  const softRows = new Set(byMoney.slice(topEnd, softEnd).map((entry) => entry.row));
  for (const entry of heat) {
    const shade = strongRows.has(entry.row) ? HEAT_TOP : softRows.has(entry.row) ? HEAT_MID : null;
    if (shade) {
      sheet.getCell(entry.row, totalColumn).fill = { type: "pattern", pattern: "solid", fgColor: { argb: shade } };
    }
  }

  // A SUBTOTAL total row, so filtering the sheet recomputes it over what is visible.
  const lastData = row - 1;
  if (lastData >= FIRST_DATA_ROW) {
    const totalRow = sheet.getCell(row, 1);
    totalRow.value = "Total (rows shown)";
    totalRow.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    totalRow.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    for (let column = idColumns.length + 1; column <= totalColumn; column += 1) {
      const letter = sheet.getColumn(column).letter;
      const cell = sheet.getCell(row, column);
      cell.value = { formula: `SUBTOTAL(109,${letter}${FIRST_DATA_ROW}:${letter}${lastData})` };
      cell.numFmt = column === totalColumn ? F_VALUE : F_UNITS;
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
  if (trend && !extraNote) extraNote = arrowNote(trend);
  if (context.weeksDropped && (tab === "area" || tab === "branch" || tab === "dist")) {
    extraNote = `${context.products.length} products x ${context.weekNumbers.length} weeks is too wide to read, so the week columns are not shown here - filter to one line for the weekly grid`;
  }
  // A rule down each side of every product's block. At 20 products x 5 columns the eye loses which
  // concentration a number belongs to; the owner asked for this by name. Merged onto whatever
  // border the cell already carries, never written over it.
  for (const span of spans) {
    for (let line = GROUP_ROW; line <= row; line += 1) {
      addSide(sheet.getCell(line, span.from), "left");
      addSide(sheet.getCell(line, span.to), "right");
    }
  }

  paintMasthead(sheet, columns, TAB_TITLE[tab], context.scopeLine, context.headline, extraNote);

  sheet.views = [
    { state: "frozen", xSplit: idColumns.length, ySplit: HEADER_ROW, showGridLines: false },
  ];
  applyPrint(sheet, columns, row);
}

/**
 * "Branches ranked" - every concentration in UNITS, each family closed by its own figure in MONEY.
 *
 * The owner's design, and the reason it has to be shaped this way: he thinks in families ("how did
 * Conviban do at this branch"), but Conviban is four concentrations and adding their units means
 * nothing - 100 mg and 25 mg are not the same object. So each family shows its concentrations in
 * units and then closes with the one figure that CAN be summed across them: money. The family
 * figures add to the row Total exactly, because both are cut from the same per-product value.
 */
function drawRankedSheet(workbook: ExcelJS.Workbook, context: SheetContext, sheetPrefix: string): void {
  const { input, products } = context;
  const tab: TabKey = "ranked";
  const sheet = workbook.addWorksheet(sanitizeSheetName(`${sheetPrefix}${TAB_SHEET[tab]}`).slice(0, 31));
  sheet.views = [{ showGridLines: false }];

  const idColumns = ID_COLUMNS[tab];
  const families = familyBlocks(products, context.familyOf);
  const groups = buildGroups(input, context.rows, tab, context.weekNumbers, context.unitPrice);
  for (const group of groups) {
    for (const product of products) {
      const key = cellKey(product.code, "M");
      if (!group.print.has(key)) group.print.set(key, Math.round(group.exact.get(key) ?? 0));
    }
  }
  groups.sort((left, right) => right.value - left.value);

  // The column plan: ids, then per family its concentrations followed by that family's money, then
  // the row total and the arrow.
  const plan: {
    name: string;
    from: number;
    money: number;
    products: { code: string; name: string }[];
  }[] = [];
  let cursor = idColumns.length + 1;
  for (const family of families) {
    const from = cursor;
    const money = from + family.products.length;
    plan.push({ name: family.name, from, money, products: family.products });
    cursor = money + 1;
  }
  const totalColumn = cursor;
  const trend = context.trend;
  const trendColumn = trend ? totalColumn + 1 : 0;
  const columns = trend ? trendColumn : totalColumn;
  const trendPairs = trend
    ? trendByGroup(input, context.rows, tab, trend, context.trendDistributors)
    : new Map<string, { last: number; prev: number }>();
  let trendLineLast = 0;
  let trendLinePrev = 0;
  for (const pair of trendPairs.values()) {
    trendLineLast += pair.last;
    trendLinePrev += pair.prev;
  }

  // Row 5: the family band, merged across its concentrations AND its money column - that figure
  // belongs to the family, not to the concentration it happens to sit beside.
  for (const block of plan) {
    if (block.money > block.from) sheet.mergeCells(GROUP_ROW, block.from, GROUP_ROW, block.money);
    const cell = sheet.getCell(GROUP_ROW, block.from);
    cell.value = block.name;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "thin", color: { argb: RULE_STRONG } } };
    for (let column = block.from; column <= block.money; column += 1) {
      sheet.getCell(GROUP_ROW, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_SOFT } };
    }
  }
  sheet.getCell(GROUP_ROW, totalColumn).value = "Sales Value (EGP)";
  styleHeader(sheet.getCell(GROUP_ROW, totalColumn), true, true);
  if (trend) {
    const band = sheet.getCell(GROUP_ROW, trendColumn);
    band.value = "Trend";
    styleHeader(band, true, true);
  }

  // Row 6: the concentrations themselves, then the family's money column.
  idColumns.forEach((label, index) => styleHeaderWith(sheet, HEADER_ROW, index + 1, label, false));
  for (const block of plan) {
    block.products.forEach((product, index) =>
      styleHeaderWith(sheet, HEADER_ROW, block.from + index, product.name, true),
    );
    styleHeaderWith(sheet, HEADER_ROW, block.money, "Family (EGP)", true);
  }
  styleHeaderWith(sheet, HEADER_ROW, totalColumn, "Total", true);
  if (trend) {
    styleHeaderWith(sheet, HEADER_ROW, trendColumn, `Share W${trend.last} vs W${trend.prev}`, true);
  }

  const heat: { row: number; value: number }[] = [];
  let row = FIRST_DATA_ROW;
  groups.forEach((group, index) => {
    idColumns.forEach((label, position) => {
      const cell = sheet.getCell(row, position + 1);
      cell.value = group.id[label] ?? "";
      cell.font = { name: "Calibri", size: 10, bold: position === 0, color: { argb: position === 0 ? INK : SUB } };
      cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    });

    const totalValue = Math.round(group.value);
    const exactFamily = plan.map((block) =>
      block.products.reduce((sum, product) => sum + (group.valueByProduct.get(product.code) ?? 0), 0),
    );
    const printedFamily = shareOut(exactFamily, totalValue);

    plan.forEach((block, blockIndex) => {
      block.products.forEach((product, position) => {
        const cell = sheet.getCell(row, block.from + position);
        const units = group.print.get(cellKey(product.code, "M")) ?? 0;
        cell.value = units;
        cell.numFmt = F_UNITS;
        cell.font = {
          name: "Calibri",
          size: 10,
          color: { argb: units === 0 ? FAINT : units < 0 ? DOWN : INK },
        };
        cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
      });
      const money = printedFamily[blockIndex] ?? 0;
      const cell = sheet.getCell(row, block.money);
      cell.value = money;
      cell.numFmt = F_VALUE;
      cell.font = {
        name: "Calibri",
        size: 10,
        bold: true,
        color: { argb: money === 0 ? FAINT : money < 0 ? DOWN : INK },
      };
      cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    });

    const totalCell = sheet.getCell(row, totalColumn);
    totalCell.value = totalValue;
    totalCell.numFmt = F_VALUE;
    totalCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    totalCell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    heat.push({ row, value: totalValue });

    if (trend) {
      const pair = trendPairs.get(groupKey(group, tab));
      const mark = pair ? shareTrend(pair, trendLineLast, trendLinePrev) : null;
      const arrow = sheet.getCell(row, trendColumn);
      arrow.value = mark ? mark.glyph : "";
      arrow.font = { name: "Calibri", size: 8, bold: true, color: { argb: mark ? mark.colour : FAINT } };
      arrow.alignment = { vertical: "middle", horizontal: "center" };
    }

    if (index % 2 === 1) {
      for (let column = 1; column <= columns; column += 1) {
        sheet.getCell(row, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
      }
    }
    row += 1;
  });

  const byMoney = heat.filter((entry) => entry.value > 0).sort((left, right) => right.value - left.value);
  const topEnd = Math.max(1, Math.round(byMoney.length * 0.1));
  const softEnd = Math.max(topEnd, Math.round(byMoney.length * 0.3));
  const strongRows = new Set(byMoney.slice(0, topEnd).map((entry) => entry.row));
  const softRows = new Set(byMoney.slice(topEnd, softEnd).map((entry) => entry.row));
  for (const entry of heat) {
    const shade = strongRows.has(entry.row) ? HEAT_TOP : softRows.has(entry.row) ? HEAT_MID : null;
    if (shade) {
      sheet.getCell(entry.row, totalColumn).fill = { type: "pattern", pattern: "solid", fgColor: { argb: shade } };
    }
  }

  const lastData = row - 1;
  if (lastData >= FIRST_DATA_ROW) {
    const label = sheet.getCell(row, 1);
    label.value = "Total (rows shown)";
    label.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    label.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    for (let column = idColumns.length + 1; column <= totalColumn; column += 1) {
      const letter = sheet.getColumn(column).letter;
      const cell = sheet.getCell(row, column);
      cell.value = { formula: `SUBTOTAL(109,${letter}${FIRST_DATA_ROW}:${letter}${lastData})` };
      cell.numFmt = plan.some((block) => block.money === column) || column === totalColumn ? F_VALUE : F_UNITS;
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
      cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    }
    for (let column = 1; column <= columns; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
      cell.border = { top: { style: "thin", color: { argb: RULE_STRONG } } };
    }
    sheet.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastData, column: columns } };
  }

  autofit(sheet, columns, HEADER_ROW, row, new Map());
  for (const block of plan) {
    let have = 0;
    for (let column = block.from; column <= block.money; column += 1) have += sheet.getColumn(column).width ?? 0;
    const need = widthOf(block.name, 10) * 1.06;
    if (have < need) {
      const last = sheet.getColumn(block.money);
      last.width = Math.round(((last.width ?? 0) + (need - have)) * 10) / 10;
    }
    for (let line = GROUP_ROW; line <= row; line += 1) {
      addSide(sheet.getCell(line, block.from), "left");
      addSide(sheet.getCell(line, block.money), "right");
    }
  }

  paintMasthead(
    sheet,
    columns,
    TAB_TITLE[tab],
    context.scopeLine,
    context.headline,
    trend ? arrowNote(trend) : null,
  );
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
  // Frozen at B7, the owner's own instruction - and this was the ONE tab that lacked it, the other
  // six having frozen at that exact line since the first build. The COLUMN is what he needs: the
  // name stays put while the weeks scroll sideways. The row half is the compromise, because this
  // sheet stacks several tables and the pinned header belongs to the first of them - worth it,
  // because a number whose row you cannot name is worth nothing at all.
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: HEADER_ROW, showGridLines: false }];
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
    buildTabSet(workbook, input, all, input.rows, "", picked.length === 1 ? picked[0] : null);
  } else {
    for (const line of lines) {
      const sameLine = (row: { line: string }) => row.line.trim().toLowerCase() === line.trim().toLowerCase();
      const forLine = all.filter(sameLine);
      if (forLine.length === 0) continue;
      buildTabSet(workbook, input, forLine, input.rows.filter(sameLine), `${line} - `, line);
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

/**
 * "Stock by branch" — what every branch is holding, per product, sectioned by region and then area.
 *
 * WHY THIS EXISTS BESIDE THE "Stock" TAB RATHER THAN REPLACING IT. That one is titled "Stock with
 * no sales" and shows only branches that sold NOTHING and still hold stock — a short exception
 * list. The owner asked for the other question: all the stock, in all the branches, so a manager can
 * see where his line is sitting. Both are useful and neither answers the other, so this is a new
 * sheet and the old one is untouched.
 *
 * THE RAW ROWS, NEVER THE SPLIT ONES. `splitWeeklyRowsByBranch` divides `stockUnits` pro rata
 * across the areas a depot serves. That is right for SALES — a depot's sales really do belong to the
 * territories it served — and it is a fabrication for STOCK, because a pack sits in ONE physical
 * building. Measured on production 2026-09-08: in the raw rows NO branch carries more than one area
 * code (230 carry exactly one, 106 carry none), so reading the raw rows makes the area grouping
 * EXACT rather than apportioned, and no branch is ever cut in half across two sections.
 *
 * ONLY DISTRIBUTORS THAT SEND A STOCK COLUMN. Measured the same day: `overseas`, `Ibn sina`,
 * `Ibn Sina-Sato` and `EGD` report stock; `POS Purchasing Sales` (107 branches) and
 * `Direct (Company)` (6) report none at all. Printing those 113 branches as zero would say "this
 * branch is empty" where the truth is "nobody told us", which is the one lie a stock sheet must not
 * tell. They are left off and the strip NAMES the distributors the sheet is built from.
 *
 * A BRANCH HOLDING NOTHING IS DROPPED. Owner instruction, 2026-09-08, after reading the real
 * August sheet: 140 of its 365 branches were empty, and a stock report that is 38% empty rows is
 * harder to read, not more complete. Only branches actually holding something are listed.
 *
 * "EMPTY" MEANS NO UNITS, NEVER ZERO VALUE. The EGP figure is units x the price this scope sold
 * that product for, so a product that is HELD but never SOLD in the period has no derived price and
 * values at zero while the packs are really on the shelf. Keying the drop on value would delete
 * exactly that stock, silently. On the August data the two predicates happen to agree (0 branches
 * carry units at zero value), which is precisely why a later change could swap them and see nothing
 * break — so the test pins a branch with units and no price as KEPT.
 *
 * An area or region left with no branches is dropped with them: a heading over nothing is noise,
 * and its own total would be zero.
 *
 * UNITS ACROSS PRODUCTS ARE NEVER ADDED (owner rule). Each product keeps its own units column;
 * the only figure that closes a row, an area, a region or the sheet is MONEY, valued at what this
 * scope actually sold each product for. Summing one product's units DOWN a column is a different
 * thing and is done — that is the same object in every cell.
 */
function drawStockByBranchSheet(workbook: ExcelJS.Workbook, context: SheetContext, sheetPrefix: string): void {
  const { input } = context;
  const sheet = workbook.addWorksheet(sanitizeSheetName(`${sheetPrefix}Stock by branch`).slice(0, 31));
  sheet.views = [{ showGridLines: false }];
  // 🔴 DO NOT SET `outlineProperties` HERE. It is the natural way to say "my headings sit above
  // the rows they own", and it produces a workbook Excel REFUSES TO OPEN — which is how this
  // sheet's first sample reached the owner: "We found a problem with some content".
  //
  // ExcelJS 4.4.0 renders the children of <sheetPr> in the wrong order (sheet-properties-xform.js
  // emits pageSetUpPr before outlinePr), but OOXML's CT_SheetPr is a SEQUENCE — tabColor,
  // outlinePr, pageSetUpPr. `applyPrint` sets pageSetup.fitToPage, so asking for
  // outlineProperties as well emits <sheetPr><pageSetUpPr/><outlinePr/></sheetPr> and Excel
  // DISCARDS THE WHOLE SHEET PART.
  //
  // Nothing here catches it: the XML is well-formed, ExcelJS reads its own output back happily,
  // `scripts/check-workbook-integrity.mjs` reports CLEAN, and CI went green. Only Excel objects,
  // and only on the sheets carrying an outline group — which is the tell. The weekly Summarized
  // Report carries the same warning for the same reason.
  //
  // What IS needed is outlineLevelRow, ABOVE the deepest level in use: ExcelJS derives a row's
  // `collapsed` flag as `outlineLevel >= properties.outlineLevelRow` and offers no setter, so the
  // default of 0 marks every grouped row collapsed while leaving it visible.
  //
  // The cost of not setting it is that summaryBelow stays at Excel's default of true, so the +/-
  // button for a group sits just below the rows it folds rather than on the heading above them.
  // The grouping itself, and every heading, is unaffected.
  sheet.properties.outlineLevelRow = 3;

  const reporting = new Set<string>();
  for (const row of context.rawRows) {
    if (num(row.stockUnits) !== 0) reporting.add(row.distributorName || row.distributorCode);
  }
  const rows = context.rawRows.filter((row) => reporting.has(row.distributorName || row.distributorCode));

  // Only products that are actually held somewhere in scope. A column of zeros across every branch
  // in the line is a column the eye has to cross and learn nothing from.
  const held = new Set<string>();
  for (const row of rows) if (num(row.stockUnits) !== 0) held.add(row.productCode);
  const products = context.products.filter((product) => held.has(product.code));

  type Branch = {
    area: string;
    branch: string;
    distributor: string;
    region: string;
    units: Map<string, number>;
    value: number;
  };
  /** One definition of a branch's identity, so the build and the drop below cannot disagree. */
  const entryKeyOf = (entry: { area: string; branch: string; distributor: string; region: string }) =>
    [entry.distributor, entry.branch, entry.region, entry.area].join("||");
  const byKey = new Map<string, Branch>();
  for (const row of rows) {
    const region = regionOf(input, row);
    const area = areaLabel(input, row);
    const branch = row.branchName || row.branchCode;
    const distributor = row.distributorName || row.distributorCode;
    const key = entryKeyOf({ area, branch, distributor, region });
    let entry = byKey.get(key);
    if (!entry) {
      entry = { area, branch, distributor, region, units: new Map(), value: 0 };
      byKey.set(key, entry);
    }
    const units = num(row.stockUnits);
    if (units !== 0) entry.units.set(row.productCode, (entry.units.get(row.productCode) ?? 0) + units);
  }
  for (const entry of byKey.values()) {
    let value = 0;
    for (const [code, units] of entry.units) value += units * (context.unitPrice.get(code) ?? 0);
    entry.value = value;
    // Owner, 2026-09-08: a branch holding nothing is not listed. Keyed on the UNITS map, which only
    // ever gains a key when a non-zero stock figure arrives — never on `value`, which can be zero
    // for stock that is genuinely there (see the note above the function).
    if (entry.units.size === 0) byKey.delete(entryKeyOf(entry));
  }

  // region -> area -> branches, each level ordered by the money it holds so the biggest problem is
  // the first thing on the page.
  // byKey now holds only branches that carry stock, so an area or region that ends up absent here
  // simply has none — there is no heading to print and no total to print under it.
  const regions = new Map<string, Map<string, Branch[]>>();
  for (const entry of byKey.values()) {
    let areas = regions.get(entry.region);
    if (!areas) regions.set(entry.region, (areas = new Map()));
    const list = areas.get(entry.area);
    if (list) list.push(entry);
    else areas.set(entry.area, [entry]);
  }
  const money = (list: Branch[]) => list.reduce((sum, entry) => sum + entry.value, 0);
  const NO_AREA = "Region level (no single area)";
  const orderedRegions = [...regions.entries()].sort(
    (left, right) => money([...right[1].values()].flat()) - money([...left[1].values()].flat()),
  );

  const FIRST_PRODUCT = 3;
  const totalColumn = FIRST_PRODUCT + products.length;
  const columns = totalColumn;

  // Row 5: one band per product, over its single units column.
  const spans: { name: string; from: number; to: number }[] = [];
  products.forEach((product, index) => {
    const column = FIRST_PRODUCT + index;
    spans.push({ name: product.name, from: column, to: column });
    const cell = sheet.getCell(GROUP_ROW, column);
    cell.value = product.name;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_SOFT } };
    cell.border = { bottom: { style: "thin", color: { argb: RULE_STRONG } } };
  });
  sheet.getCell(GROUP_ROW, totalColumn).value = "Stock value (EGP)";
  styleHeader(sheet.getCell(GROUP_ROW, totalColumn), true, true);

  // Row 6: the header.
  ["Branch", "Distributor"].forEach((label, index) => {
    const cell = sheet.getCell(HEADER_ROW, index + 1);
    cell.value = label;
    styleHeader(cell, false);
  });
  // The band above already names the product, so the header says what the NUMBER is. It has to,
  // because the last column on the row is money and every column before it is not.
  products.forEach((_product, index) => {
    const cell = sheet.getCell(HEADER_ROW, FIRST_PRODUCT + index);
    cell.value = "Units";
    styleHeader(cell, true);
  });
  const totalHeader = sheet.getCell(HEADER_ROW, totalColumn);
  totalHeader.value = "EGP";
  styleHeader(totalHeader, true);

  const unitsOf = (entry: Branch, code: string) => Math.round(entry.units.get(code) ?? 0);
  const heat: { row: number; value: number }[] = [];
  let row = FIRST_DATA_ROW;

  /** A figure row: per-product units, closed by money. Used by every level of the section. */
  const writeNumbers = (line: number, get: (code: string) => number, value: number, bold: boolean, zebra: boolean) => {
    products.forEach((product, index) => {
      const column = FIRST_PRODUCT + index;
      const units = get(product.code);
      const cell = sheet.getCell(line, column);
      cell.value = units;
      cell.numFmt = F_UNITS;
      cell.font = { name: "Calibri", size: 10, bold, color: { argb: units === 0 ? FAINT : INK } };
      cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
      if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    });
    const cell = sheet.getCell(line, totalColumn);
    cell.value = Math.round(value);
    cell.numFmt = F_VALUE;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: value === 0 ? FAINT : INK } };
    cell.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
  };

  for (const [regionName, areas] of orderedRegions) {
    const regionBranches = [...areas.values()].flat();

    // ── the region band ──────────────────────────────────────────────────────
    const regionRow = row;
    sheet.mergeCells(regionRow, 1, regionRow, 2);
    const regionCell = sheet.getCell(regionRow, 1);
    regionCell.value = regionName;
    regionCell.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } };
    regionCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    const regionTotals = (code: string) => regionBranches.reduce((sum, entry) => sum + unitsOf(entry, code), 0);
    writeNumbers(regionRow, regionTotals, money(regionBranches), true, false);
    for (let column = 1; column <= columns; column += 1) {
      const cell = sheet.getCell(regionRow, column);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } };
      cell.border = {
        ...(cell.border ?? {}),
        bottom: { style: "medium", color: { argb: ACCENT } },
        top: { style: "medium", color: { argb: ACCENT } },
      };
    }
    sheet.getRow(regionRow).height = 20;
    row += 1;

    // Areas biggest first, with the branches that belong to no single area always LAST — they are
    // the key accounts and wholesale depots, and they are the least useful thing to open on.
    const orderedAreas = [...areas.entries()].sort((left, right) => {
      if (left[0] === NO_AREA) return 1;
      if (right[0] === NO_AREA) return -1;
      return money(right[1]) - money(left[1]);
    });

    for (const [areaName, branches] of orderedAreas) {
      // ── the area sub-heading ───────────────────────────────────────────────
      const areaRow = row;
      sheet.mergeCells(areaRow, 1, areaRow, 2);
      const areaCell = sheet.getCell(areaRow, 1);
      areaCell.value = areaName;
      areaCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: areaName === NO_AREA ? SUB : INK } };
      areaCell.alignment = { vertical: "middle", horizontal: "left", indent: 2 };
      const areaTotals = (code: string) => branches.reduce((sum, entry) => sum + unitsOf(entry, code), 0);
      writeNumbers(areaRow, areaTotals, money(branches), true, false);
      for (let column = 1; column <= columns; column += 1) {
        const cell = sheet.getCell(areaRow, column);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_SOFT } };
        cell.border = { ...(cell.border ?? {}), bottom: { style: "thin", color: { argb: RULE_STRONG } } };
      }
      sheet.getRow(areaRow).outlineLevel = 1;
      row += 1;

      // ── the branches ───────────────────────────────────────────────────────
      // Holding something first, biggest first; the empty ones fall to the bottom of their own area
      // rather than being scattered through it.
      const ordered = [...branches].sort((left, right) => right.value - left.value || left.branch.localeCompare(right.branch));
      ordered.forEach((entry, index) => {
        const line = row;
        const zebra = index % 2 === 1;
        const nameCell = sheet.getCell(line, 1);
        nameCell.value = entry.branch;
        // Every branch here holds something, so the name is always full ink. A zero can still be
        // printed in an individual PRODUCT cell, and that one keeps the faint treatment.
        nameCell.font = { name: "Calibri", size: 10, color: { argb: INK } };
        nameCell.alignment = { vertical: "middle", horizontal: "left", indent: 3 };
        const distCell = sheet.getCell(line, 2);
        distCell.value = entry.distributor;
        distCell.font = { name: "Calibri", size: 10, color: { argb: SUB } };
        distCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        if (zebra) {
          for (const column of [1, 2]) {
            sheet.getCell(line, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
          }
        }
        writeNumbers(line, (code) => unitsOf(entry, code), entry.value, false, zebra);
        sheet.getRow(line).outlineLevel = 2;
        heat.push({ row: line, value: entry.value });
        row += 1;
      });
    }
  }

  // ── the sheet total ────────────────────────────────────────────────────────
  const everything = [...byKey.values()];
  if (everything.length > 0) {
    const totalRow = row;
    sheet.mergeCells(totalRow, 1, totalRow, 2);
    const label = sheet.getCell(totalRow, 1);
    label.value = "Total stock on hand";
    label.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
    label.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    writeNumbers(
      totalRow,
      (code) => everything.reduce((sum, entry) => sum + unitsOf(entry, code), 0),
      money(everything),
      true,
      false,
    );
    for (let column = 1; column <= columns; column += 1) {
      const cell = sheet.getCell(totalRow, column);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
      cell.border = { ...(cell.border ?? {}), top: { style: "thin", color: { argb: RULE_STRONG } } };
    }
    row += 1;
  }

  // The heaviest branches get the warm wash on their money column, the same one the rest of the
  // book uses to say "this row is large" — it is data, not decoration.
  const ranked = heat.filter((entry) => entry.value > 0).sort((left, right) => right.value - left.value);
  const strongRows = new Set(ranked.slice(0, Math.ceil(ranked.length * 0.1)).map((entry) => entry.row));
  const softRows = new Set(ranked.slice(Math.ceil(ranked.length * 0.1), Math.ceil(ranked.length * 0.3)).map((entry) => entry.row));
  for (const entry of heat) {
    const shade = strongRows.has(entry.row) ? HEAT_TOP : softRows.has(entry.row) ? HEAT_MID : null;
    if (shade) sheet.getCell(entry.row, totalColumn).fill = { type: "pattern", pattern: "solid", fgColor: { argb: shade } };
  }

  const floor = new Map<number, number>();
  autofit(sheet, columns, HEADER_ROW, row - 1, floor);
  // A merged band is never measured by autofit, so give a product column whatever its own name needs.
  for (const span of spans) {
    const column = sheet.getColumn(span.to);
    const need = widthOf(span.name, 10) * 0.62;
    if ((column.width ?? 0) < need) column.width = Math.round(need * 10) / 10;
  }
  sheet.getRow(GROUP_ROW).height = 30;

  // A rule down each side of every product's column — the owner asked for these by name on the
  // other grids, and this one is just as wide.
  for (const span of spans) {
    for (let line = GROUP_ROW; line <= row - 1; line += 1) {
      addSide(sheet.getCell(line, span.from), "left");
      addSide(sheet.getCell(line, span.to), "right");
    }
  }

  const named = [...reporting].sort();
  const note =
    named.length > 0
      ? `branches holding stock, from the distributors that send a stock column - ${named.join(", ")}; a branch holding nothing is not listed, and distributors that report no stock at all are not on this sheet`
      : "no distributor in this scope reports stock on hand";
  paintMasthead(sheet, columns, "Stock on hand, by branch", context.scopeLine, context.headline, note);

  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: HEADER_ROW, showGridLines: false }];
  applyPrint(sheet, columns, row - 1);
}

function buildTabSet(
  workbook: ExcelJS.Workbook,
  input: NsmDsmWorkbookInput,
  rows: Split[],
  rawRows: WeeklyFactExportRow[],
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
  // When the caller knows the reader's seat (the portal download — one named manager, already
  // narrowed to his own scope) his OWN seat names the masthead. Only the region COUNT was available
  // before, which named the national manager over a regional manager's own numbers, and the
  // district manager of whichever region a single-region book happened to cover.
  const coverage =
    regions.length === 1
      ? `${regions[0]} only`
      : regions.length <= 4
        ? regions.join(", ")
        : `${regions.length} regions`;
  const who =
    input.viewerSeat === "rsm"
      ? scopeWho(bucket?.rsmName ?? null, "Regional Sales Manager", coverage)
      : input.viewerSeat === "nsm"
        ? scopeWho(bucket?.nsmName ?? null, "National Sales Manager", regions.length === 1 ? coverage : "all regions")
        : regions.length === 1
          ? scopeWho(bucket?.managerName ?? null, "District Manager", `${regions[0]} only`)
          : scopeWho(bucket?.nsmName ?? null, "National Sales Manager", "all regions");
  const scopeLine = [lineLabel ? lineLabel.toUpperCase() : "ALL TRACKED LINES", who].join("   ·   ");

  // A product-by-week grid wider than ~120 columns cannot be read on paper. Drop the weeks rather
  // than the products, and SAY SO on the sheet — a silent cut reads as "this is everything".
  const weeksDropped = products.length * (weekNumbers.length + 1) > 120;

  const familyOf = new Map<string, string>();
  for (const row of rows) {
    if (!familyOf.has(row.productCode)) familyOf.set(row.productCode, (row.family ?? "").trim());
  }

  // Money per week for the WHOLE scope, which is what decides the two weeks the arrows compare.
  // `salesValue` is already the split figure - splitWeeklyRowsByBranch divides it before this file
  // ever sees it - so it is summed as it stands, never re-weighted.
  const valueByWeek = new Map<number, number>();
  for (const row of rows) {
    const week = row.weekNumber;
    if (week === null || !weekNumbers.includes(week)) continue;
    valueByWeek.set(week, (valueByWeek.get(week) ?? 0) + num(row.salesValue));
  }
  const trendPeriod = trendPair(valueByWeek);

  const context: SheetContext = {
    input,
    rows,
    rawRows,
    products,
    weekNumbers,
    weekLabel,
    headline,
    scopeLine,
    unitPrice: unitPrices(rows),
    targets: lineTargetsFor(rows, weekNumbers, input),
    familyOf,
    trend: trendPeriod,
    trendDistributors: trendPeriod
      ? comparableDistributors(rows, trendPeriod.last, trendPeriod.prev)
      : new Set<string>(),
    weeksDropped,
  };

  drawSummarySheet(workbook, context, sheetPrefix);
  for (const tab of ["area", "branch", "dist"] as TabKey[]) drawFlatSheet(workbook, tab, context, sheetPrefix);
  drawRankedSheet(workbook, context, sheetPrefix);
  drawFlatSheet(workbook, "stock", context, sheetPrefix);
  drawStockByBranchSheet(workbook, context, sheetPrefix);
  drawFlatSheet(workbook, "details", context, sheetPrefix);
}
