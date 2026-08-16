// Weekly Sales — "Summarized Report": a 5-tab management workbook.
//
// This is a SECOND, additive export. The analyst BI workbook (export-workbook.ts, ExcelForge) and
// its export-kit are deliberately untouched — nothing here imports them, so the two cannot drift
// into each other. This one is built on ExcelJS via sales-workbook-kit, the same primitives the
// combined-batches export already uses.
//
// EVERY figure comes from WeeklyDashboard.factRows, which loadWeeklyDashboard has already
// de-cumulated (W2 minus W1 = what W2 actually sold), re-valued against current Product Master
// price, and access-scope redacted. That is what makes this workbook reconcile exactly to the
// on-screen dashboard for the same filters.
//
// Do NOT be tempted to source any of this from analytics loadWeeklyFact(): that reads the raw
// CUMULATIVE fact with no de-cumulation and no stock guard, so summing it double-counts sales and
// multiplies stock on hand.

import ExcelJS from "exceljs";

import { systemIdentity } from "@/config/system-settings";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
// Only MUTED and sanitizeSheetName remain from the shared kit: every tab now draws its own premium
// grid, so bandHeader/writeTable/UNITS_FMT/VALUE_FMT are no longer reachable from this workbook.
import { MUTED, sanitizeSheetName } from "@/lib/sales/sales-workbook-kit";
import { monthlyClosingRegionRank } from "@/lib/sales/monthly-distributor-import";
import {
  ATTRIBUTION_CAVEAT,
  compareManagerBuckets,
  reportingLine,
  resolveWeeklyManager,
  type WeeklyManagerBucket,
  type WeeklyManagerIndex,
} from "@/lib/sales/weekly/manager-attribution";
import type { WeeklyDashboard, WeeklyFactExportRow } from "@/lib/sales/weekly/types";

// ── Period helpers ────────────────────────────────────────────────────────────
// Weekly periods are cycle months (first-of-month), not calendar ranges — the pipeline cannot
// express "Aug 1 to Aug 11" because de-cumulation buckets strictly by (distributor, cycle_month).
// So "month to date" means "the current cycle month, whatever weeks have been uploaded into it".

/** Current Cairo cycle month as YYYY-MM-01. Cairo, never UTC — the owner's reporting timezone. */
export function currentCairoCycleMonth(now: Date = new Date()): string {
  return `${currentCairoDateOnlyIso(now).slice(0, 7)}-01`;
}

/** Every cycle month of the current Cairo year up to and including the current month. */
export function cycleMonthsOfCurrentYear(now: Date = new Date()): string[] {
  const iso = currentCairoDateOnlyIso(now);
  const year = iso.slice(0, 4);
  const month = Number(iso.slice(5, 7));
  const out: string[] = [];
  for (let m = 1; m <= month; m += 1) out.push(`${year}-${String(m).padStart(2, "0")}-01`);
  return out;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export type SummaryTotals = { salesUnits: number; salesValue: number; stockUnits: number };

const ZERO: SummaryTotals = { salesUnits: 0, salesValue: 0, stockUnits: 0 };

function addInto(target: SummaryTotals, row: WeeklyFactExportRow): void {
  target.salesUnits += row.salesUnits;
  target.salesValue += row.salesValue;
  target.stockUnits += row.stockUnits;
}

function sumRows(rows: WeeklyFactExportRow[]): SummaryTotals {
  const total = { ...ZERO };
  for (const row of rows) addInto(total, row);
  return total;
}

/**
 * THE YTD STOCK REDUCTION — the one genuinely dangerous calculation in this file.
 *
 * factRows arrive already latestStockOnly-adjusted by the engine: stock is zeroed on every week
 * except the latest in-scope week of each (distributor, cycle_month). That is exactly right for a
 * single month. Across a YEAR it is not: it leaves one non-zero stock week per distributor PER
 * MONTH, so a naive sum yields "sum of N month-end snapshots" — the inventory multiplication the
 * engine's own comment warns about. Four months of data would report roughly 4x the real stock.
 *
 * Stock is a point-in-time snapshot and can only ever be reported "as of" a moment. So for a
 * multi-month scope, keep stock only from each distributor's LATEST cycle month in scope and zero
 * it everywhere else. Sales units and value are untouched — de-cumulation telescopes, so those do
 * sum correctly across weeks and months.
 */
export function latestCycleMonthStockOnly(rows: WeeklyFactExportRow[]): WeeklyFactExportRow[] {
  const latestByDistributor = new Map<string, string>();
  for (const row of rows) {
    if (!row.cycleMonth) continue;
    const current = latestByDistributor.get(row.distributorCode);
    if (!current || row.cycleMonth > current) latestByDistributor.set(row.distributorCode, row.cycleMonth);
  }
  return rows.map((row) =>
    row.cycleMonth && row.cycleMonth === latestByDistributor.get(row.distributorCode)
      ? row
      : { ...row, stockUnits: 0 },
  );
}

/**
 * Tab 5 predicate: the branch is holding stock it is not selling.
 *
 * Zero-sales branches are the whole point and must be kept — a branch with 0 sold and 100 on hand
 * is the most serious case on the list, not an empty row to filter away.
 */
export function isLowSalesWithStock(salesUnits: number, stockUnits: number): boolean {
  return salesUnits >= 0 && salesUnits <= 5 && stockUnits > 0;
}

/**
 * Tab 5 only shows a stuck product once it is worth a journey.
 *
 * At branch × PRODUCT the raw predicate flags a lot: 959 rows across 102 branches on the August
 * sheet, several branches carrying 18-19 stuck products each. Every one of those rows is true, but a
 * product sitting on a handful of units is not what anyone should drive out for, and burying the
 * real cases in them is how an action list stops being read.
 *
 * 50 units is the owner's chosen line (2026-08-12). It is a DISPLAY threshold on this one tab —
 * isLowSalesWithStock itself is unchanged, so the underlying rule and its tests still mean what they
 * always did, and the count of what fell below the line is printed on the sheet rather than silently
 * dropped.
 */
const LOW_SALES_STOCK_FLOOR = 50;

/**
 * Tab 5 only: Head Office is excluded from the action list.
 *
 * It has no field manager by design, so nobody can be asked to go and chase those branches — and it
 * is large enough to drown the tab (measured 2026-08-11: 234,579 of 313,288 flagged stock units,
 * 75%, sat under the CEO). Owner's call on 2026-08-11: keep Head Office under the CEO everywhere
 * else, drop it here so the tab stays a list a district manager can act on.
 *
 * This is a DISPLAY scope decision limited to this one sheet — Tabs 2, 3 and 4 still carry Head
 * Office in full, so the workbook's other totals continue to reconcile to the dashboard.
 */
export function isActionableLowSalesBucket(kind: WeeklyManagerBucket["kind"]): boolean {
  return kind !== "ceo";
}

type ManagerGroup = { bucket: WeeklyManagerBucket; rows: WeeklyFactExportRow[] };

/** Bucket every fact row by its owning manager, in section order. */
export function groupRowsByManager(
  rows: WeeklyFactExportRow[],
  index: WeeklyManagerIndex,
): ManagerGroup[] {
  const groups = new Map<string, ManagerGroup>();
  for (const row of rows) {
    const bucket = resolveWeeklyManager(index, row.line, row.regionCode);
    const existing = groups.get(bucket.key);
    if (existing) existing.rows.push(row);
    else groups.set(bucket.key, { bucket, rows: [row] });
  }
  return [...groups.values()].sort((a, z) => compareManagerBuckets(a.bucket, z.bucket));
}

/** Roll rows up to one entry per key, newest-largest first by value. */
function rollup(
  rows: WeeklyFactExportRow[],
  keyOf: (row: WeeklyFactExportRow) => string,
  labelOf: (row: WeeklyFactExportRow) => string,
): Array<{ key: string; label: string } & SummaryTotals> {
  const map = new Map<string, { key: string; label: string } & SummaryTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = map.get(key) ?? { key, label: labelOf(row) || key, ...ZERO };
    addInto(existing, row);
    map.set(key, existing);
  }
  return [...map.values()].sort((a, z) => z.salesValue - a.salesValue || a.label.localeCompare(z.label));
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

// ── Line splitting ────────────────────────────────────────────────────────────
// Owner's rule, verbatim: no line filter on the dashboard -> a tab per line; a line filter set ->
// follow the filter only. He does not want "كل الدنيا كلها" in one sheet for everyone.

const normalizeLine = (value: string | null | undefined) => (value ?? "").trim();
/** Region codes are compared against the Monthly Closing order, which is upper-case. */
const normalizeRegion = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
const sameLine = (a: string | null | undefined, b: string) =>
  normalizeLine(a).toLowerCase() === b.trim().toLowerCase();

/** Head Office has no field manager, so it gets no action list. */
const isHeadOffice = (line: string) => line.trim().toLowerCase() === "head office";

/**
 * Which lines get their own tab set.
 *
 * Owner's rule (2026-08-11): splitting into a sheet per line is NOT the default — it happens only
 * when he deliberately picks more than one line. So:
 *   - no line filter   -> [] = ONE combined tab set covering every line
 *   - one line picked  -> that line alone, still one tab set
 *   - many lines picked-> one tab set per line, in the order he picked them
 *
 * An earlier build split every line unconditionally and produced 19 sheets, which he rejected:
 * "dont make all line like this one sheet per line".
 */
export function resolveLineTabs(lineFilter: string[]): string[] {
  const picked = [...new Set(lineFilter.map(normalizeLine).filter(Boolean))];
  return picked.length > 1 ? picked : [];
}

/** Excel caps sheet names at 31 chars, so a line prefix plus the longest suffix must still fit. */
function sheetName(line: string, suffix: string): string {
  return sanitizeSheetName(`${line} - ${suffix}`).slice(0, 31);
}

export type WeeklySummaryInput = {
  /** The dashboard load for the user's CURRENT filters — drives Tabs 1, 2. */
  weekly: WeeklyDashboard;
  /** Current cycle month, all weeks — drives Tabs 3 and 5. */
  mtd: WeeklyDashboard;
  /** Every cycle month of the current year, all weeks — drives Tab 4. */
  ytd: WeeklyDashboard;
  managerIndex: WeeklyManagerIndex;
  /** Jan..current cycle months, so a month with no uploads can be reported as a real zero. */
  ytdMonths: string[];
  periodLabel: string;
  generatedAt: string;
  /**
   * Lines the viewer picked on the dashboard. None or one = a single combined tab set; more than
   * one = a tab set per picked line. See resolveLineTabs.
   */
  lineFilter: string[];
  /**
   * Same scope as `weekly` but EVERY week of its cycle month(s).
   *
   * The trend column needs a series; the selected upload is a single point. Supplied separately so
   * the grid stays strictly on the chosen sheet while the sparkline can still show the trajectory
   * around it.
   */
  trend: WeeklyDashboard;
  /**
   * The Source-of-Sales area vocabulary, so Tab 2 can print "Dakahlia 3" instead of "D23".
   *
   * Passed in rather than looked up here: the workbook builder stays pure and has no database of its
   * own, which is what keeps it unit-testable without a connection.
   */
  masterAreas: Array<{ areaCode: string; areaName: string; regionCode?: string }>;
  /**
   * The Month vs Target tab — everything it needs, resolved by the caller.
   *
   * `monthRows` is the WHOLE cycle month being uploaded, not the selected week: the target it is
   * measured against is a month's target, so a week's sales would report a false 20%.
   */
  vsTarget: {
    /** The cycle month under measurement, YYYY-MM. */
    period: string;
    monthRows: WeeklyFactExportRow[];
    targets: MonthTargetInput[];
    /** Official line names carrying a target this month — tells "no target" from "target of 0". */
    targetedLines: string[];
    regionNames: Array<{ regionCode: string; regionName: string }>;
    /** Non-empty when a distributor/product filter narrows the sales but cannot narrow the target. */
    filterCaveat: string;
  };
};

export async function buildWeeklySummaryWorkbook(input: WeeklySummaryInput): Promise<Buffer> {
  const { weekly, mtd, ytd, managerIndex, ytdMonths, periodLabel, generatedAt, lineFilter } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();
  // Excel recalculates this workbook on open regardless; saying so explicitly means the numbers a
  // reader sees are the formulas' own output, never a stale cached result pretending otherwise.
  workbook.calcProperties.fullCalcOnLoad = true;

  const weeklyRows = weekly.factRows ?? [];
  const mtdRows = mtd.factRows ?? [];
  const ytdRows = latestCycleMonthStockOnly(ytd.factRows ?? []);
  const trendRows = input.trend.factRows ?? [];
  const areaNames = new Map((input.masterAreas ?? []).map((a) => [a.areaCode.trim().toUpperCase(), a.areaName]));
  // The same master areas, now carrying the region that owns each one — the Month vs Target tab
  // rolls areas up by THEIR region so its subtotals reconcile (see Tab 6's header comment).
  const areaIndex = new Map(
    (input.masterAreas ?? []).map((area) => [
      area.areaCode.trim().toUpperCase(),
      { areaName: area.areaName, regionCode: (area.regionCode ?? "").trim().toUpperCase() },
    ]),
  );
  const regionNames = new Map(
    (input.vsTarget.regionNames ?? []).map((region) => [region.regionCode.trim().toUpperCase(), region.regionName]),
  );
  const monthRows = input.vsTarget.monthRows ?? [];
  const monthTargets = input.vsTarget.targets ?? [];

  const lines = resolveLineTabs(lineFilter);

  // No split (the default, and the single-line case): one tab set over everything already loaded.
  // The loader has applied the line filter itself, so "everything" is exactly what he asked for.
  if (lines.length === 0) {
    // One line picked still means ONE tab set — but say which line it is. "All lines" on a sheet the
    // viewer deliberately filtered to Anti Infective is simply wrong.
    const soleLine = lineFilter.map(normalizeLine).filter(Boolean);
    buildTabSet(workbook, null, weeklyRows, mtdRows, ytdRows, ytd.factRows ?? [], {
      managerIndex,
      ytdMonths,
      periodLabel,
      generatedAt,
      scopeLabel: soleLine.length === 1 ? soleLine[0] : "All lines",
      trendRows,
      areaNames,
      areaIndex,
      regionNames,
      vsTargetPeriod: input.vsTarget.period,
      vsTargetFilterCaveat: input.vsTarget.filterCaveat,
      monthRows,
      monthTargets,
      targetedLines: input.vsTarget.targetedLines ?? [],
    });
  } else {
    for (const line of lines) {
      const forLine = (rows: WeeklyFactExportRow[]) => rows.filter((row) => sameLine(row.line, line));
      buildTabSet(workbook, line, forLine(weeklyRows), forLine(mtdRows), forLine(ytdRows), forLine(ytd.factRows ?? []), {
        managerIndex,
        ytdMonths,
        periodLabel,
        generatedAt,
        trendRows: forLine(trendRows),
        areaNames,
        areaIndex,
        regionNames,
        vsTargetPeriod: input.vsTarget.period,
        vsTargetFilterCaveat: input.vsTarget.filterCaveat,
        monthRows: forLine(monthRows),
        // A per-line tab set must carry ONLY that line's target, or the sheet compares one line's
        // sales against every line's number.
        monthTargets: monthTargets.filter((target) => sameLine(target.lineLabel, line)),
        targetedLines: (input.vsTarget.targetedLines ?? []).filter((label) => sameLine(label, line)),
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** The five reports for one scope — either the whole selection, or one line of it. */
function buildTabSet(
  workbook: ExcelJS.Workbook,
  line: string | null,
  weeklyRows: WeeklyFactExportRow[],
  mtdRows: WeeklyFactExportRow[],
  ytdRows: WeeklyFactExportRow[],
  ytdRawRows: WeeklyFactExportRow[],
  ctx: {
    managerIndex: WeeklyManagerIndex;
    ytdMonths: string[];
    periodLabel: string;
    generatedAt: string;
    scopeLabel?: string;
    /** Same scope, every week of the cycle month — the series the trend column draws. */
    trendRows: WeeklyFactExportRow[];
    /** area_code -> area name, so Tab 2 prints "Dakahlia 3" rather than "D23". */
    areaNames: Map<string, string>;
    /** area_code -> name AND owning region — Tab 6 needs the region to make its subtotals add up. */
    areaIndex: Map<string, { areaName: string; regionCode: string }>;
    regionNames: Map<string, string>;
    /** The cycle month Tab 6 measures, YYYY-MM. */
    vsTargetPeriod: string;
    vsTargetFilterCaveat: string;
    /** The WHOLE month being uploaded — Tab 6 only. Tabs 1-2 stay on the selected sheet. */
    monthRows: WeeklyFactExportRow[];
    monthTargets: MonthTargetInput[];
    targetedLines: string[];
  },
): void {
  const { managerIndex, ytdMonths, periodLabel, generatedAt } = ctx;
  const label = line ?? ctx.scopeLabel ?? "All lines";
  const name = (suffix: string) => (line ? sheetName(line, suffix) : suffix);

  buildBranchSheet(workbook, name("Weekly by Branch"), weeklyRows, label, periodLabel, generatedAt, ctx.trendRows);
  // The same numbers, cut two ways. AREA is what a manager owns and is measured on; BRANCH is where
  // he has to send someone. Both are built by one writer, so they cannot drift apart.
  buildManagerSheet(
    workbook,
    name("Weekly by Manager"),
    weeklyRows,
    managerIndex,
    label,
    periodLabel,
    generatedAt,
    ctx.trendRows,
    ctx.areaNames,
    "area",
  );
  buildManagerSheet(
    workbook,
    name("Manager by Branch"),
    weeklyRows,
    managerIndex,
    label,
    periodLabel,
    generatedAt,
    ctx.trendRows,
    ctx.areaNames,
    "branch",
  );
  buildDistributorSheet(workbook, name("MTD by Distributor"), mtdRows, managerIndex, {
    title: `${label} — Month to Date by Distributor`,
    subtitle: `Cycle month ${currentCairoCycleMonth()} · all uploaded weeks · Generated ${generatedAt}`,
    unitsLabel: "MTD Units",
    stockLabel: "Stock Units",
    note: ATTRIBUTION_CAVEAT,
  });
  // Straight after the MTD tab: both measure the same month, and this one says whether that month is
  // on course. Ahead of YTD deliberately — the question a manager opens this workbook with is
  // "where am I against my number", not "what has the year done".
  buildVsTargetSheet(
    workbook,
    name("Month vs Target"),
    buildVsTargetModel(ctx.monthRows, ctx.monthTargets, ctx.areaIndex, ctx.targetedLines, ctx.regionNames),
    label,
    ctx.vsTargetPeriod,
    generatedAt,
    ctx.vsTargetFilterCaveat,
  );
  buildDistributorSheet(workbook, name("YTD by Distributor"), ytdRows, managerIndex, {
    title: `${label} — Year to Date by Distributor`,
    subtitle: `${ytdMonths[0] ?? "—"} to ${currentCairoCycleMonth()} · Generated ${generatedAt}`,
    unitsLabel: "YTD Units",
    // Never "YTD Stock": stock is a snapshot, so the only honest YTD stock figure is the latest one.
    stockLabel: "Stock on Hand (latest)",
    note: `${ATTRIBUTION_CAVEAT}  ${ytdCoverageNote(ytdMonths, ytdRawRows)}`,
  });
  if (!line || !isHeadOffice(line)) {
    buildLowSalesSheet(workbook, name("Low Sales With Stock"), mtdRows, managerIndex, label, generatedAt, ctx.areaNames);
  }
}

/**
 * Name the months that have no uploads. Without this a zero row is indistinguishable from a real
 * collapse in sales — the repo rule is that an unavailable source must say so, never render a
 * misleading zero. Weekly data currently begins May 2026, so Jan-Apr are legitimately empty.
 */
export function ytdCoverageNote(ytdMonths: string[], rows: WeeklyFactExportRow[]): string {
  const present = new Set(rows.map((row) => row.cycleMonth).filter(Boolean));
  const missing = ytdMonths.filter((month) => !present.has(month));
  if (missing.length === 0) return "All months of the year have uploads.";
  return `No weekly uploads yet for: ${missing.map((m) => m.slice(0, 7)).join(", ")} — those months count as zero, not as lost sales.`;
}

// ── Tab 1: Weekly by Branch ───────────────────────────────────────────────────

function buildBranchSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: WeeklyFactExportRow[],
  lineLabel: string,
  periodLabel: string,
  generatedAt: string,
  trendRows: WeeklyFactExportRow[],
): void {
  const sheet = workbook.addWorksheet(name);

  if (rows.length === 0) {
    premiumMasthead(sheet, PAGE_COLS, lineLabel, "No data", periodLabel, generatedAt, "Region × Product");
    sheet.getCell(7, 1).value = "No validated weekly sales for the selected period.";
    sheet.views = [{ showGridLines: false }];
    return;
  }

  const sheetDates = [...new Set(rows.map((r) => r.weekStart).filter(Boolean))].sort();
  const coverage =
    sheetDates.length === 1
      ? `Sheet of ${sheetDates[0]}`
      : `Sheets ${sheetDates[0]} to ${sheetDates[sheetDates.length - 1]}`;

  // ONE BLOCK PER LINE, stacked, each line further split by family. Never every line's products side
  // by side in one giant grid — a 26-product row spanning four unrelated lines is unreadable, and no
  // manager owns all of them.
  const linesPresent = [...new Set(rows.map((r) => normalizeLine(r.line)).filter(Boolean))].sort(
    (a, z) =>
      rows.filter((r) => sameLine(r.line, z)).reduce((s, r) => s + r.salesUnits, 0) -
      rows.filter((r) => sameLine(r.line, a)).reduce((s, r) => s + r.salesUnits, 0),
  );
  const unlined = rows.filter((r) => !normalizeLine(r.line));
  const blocks = [
    ...linesPresent.flatMap((line) => splitLineIntoFamilyBlocks(rows.filter((r) => sameLine(r.line, line)))),
    // Rows the master left without a line still sold something. Count it and show it — never let a
    // sales row disappear because a reference field was blank.
    ...(unlined.length > 0 ? splitLineIntoFamilyBlocks(unlined) : []),
  ];

  premiumMasthead(sheet, PAGE_COLS, lineLabel, coverage, periodLabel, generatedAt, "Region × Product");

  // The per-product strip sits directly under the masthead but can only be FILLED once the blocks
  // below exist and their total cells have addresses. So reserve its rows now, write the blocks,
  // then come back and populate it.
  const productCount = new Set(rows.map((r) => r.productCode)).size;
  const stripRows = Math.ceil(productCount / (PAGE_COLS - 1)) * 3 + 1;
  const stripStart = 6;

  let row = stripStart + stripRows;
  // Every fact row lands in exactly ONE block — one line, then one family bin — so the block totals
  // partition the data and summing them cannot double-count. That is the whole reason the KPI cards
  // reference the TOTAL cells and never the region cells: adding both would count everything twice.
  const kpiProductRefs: Array<{ label: string; units: string; stock: string }> = [];
  for (const block of blocks) {
    const written = writeRegionProductBlock(sheet, row, block.label, block.rows, trendRows);
    kpiProductRefs.push(...written.productRefs);
    row = written.nextRow + 1; // breathing room between blocks
  }

  // Now the block totals exist, fill the reserved strip with live references to them.
  writeProductStrip(sheet, stripStart, kpiProductRefs, PAGE_COLS);

  sheet.mergeCells(row + 1, 1, row + 1, PAGE_COLS);
  const footnote = sheet.getCell(row + 1, 1);
  footnote.value =
    "Regions come from the weekly branch mapping. Units are this sheet's own sale, de-cumulated. " +
    "Unmapped products are excluded — an unmapped SKU double-counts against the real product it " +
    "belongs to. Stock is a point-in-time snapshot and is never summed across weeks.";
  footnote.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9 };
  footnote.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sheet.getRow(row + 1).height = 26;

  dressPage(sheet, row + 1, PAGE_COLS);

  // Freeze the region column only: header rows differ per block, so a row freeze would pin the first
  // block's headers over every table below it.
  sheet.views = [{ state: "frozen", xSplit: 1, showGridLines: false }];
}

/**
 * The sheet's masthead: eyebrow, title, context line, accent rule and a KPI strip.
 *
 * Deliberately richer than the shared bandHeader — this workbook goes to the CEO and the line
 * managers, and the owner asked for a premium finish. It stays inside the Phoenix identity (black
 * ground, orange accent) rather than inventing a second brand.
 */
function premiumMasthead(
  sheet: ExcelJS.Worksheet,
  cols: number,
  lineLabel: string,
  coverage: string,
  periodLabel: string,
  generatedAt: string,
  /** The sheet's axis, named in the context line: "Region × Product", "Manager × Branch × Product". */
  axisLabel: string,
): void {
  const band = (row: number, height: number) => {
    for (let c = 1; c <= cols; c += 1) {
      sheet.getCell(row, c).fill = { fgColor: { argb: INK }, pattern: "solid", type: "pattern" };
    }
    sheet.getRow(row).height = height;
  };

  band(1, 8); // top air inside the dark band — the masthead should not feel crammed
  band(2, 14);
  sheet.mergeCells(2, 1, 2, cols);
  const eyebrow = sheet.getCell(2, 1);
  // Spaced capitals read as a wordmark; tight capitals read as a spreadsheet label.
  eyebrow.value = [...`${systemIdentity.appName} · Weekly Sales`.toUpperCase()].join(" ");
  eyebrow.font = { bold: true, color: { argb: ACCENT }, name: "Calibri", size: 7.5 };
  eyebrow.alignment = { horizontal: "center", vertical: "middle" };

  band(3, 30);
  sheet.mergeCells(3, 1, 3, cols);
  const title = sheet.getCell(3, 1);
  title.value = lineLabel;
  title.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri Light", size: 22 };
  title.alignment = { horizontal: "center", vertical: "middle" };

  band(4, 15);
  sheet.mergeCells(4, 1, 4, cols);
  const context = sheet.getCell(4, 1);
  // Join only the parts that exist — a sheet whose caption already carries its own timestamp must
  // not also print a bare "Generated" with nothing after it.
  context.value = [axisLabel, coverage, periodLabel, generatedAt ? `Generated ${generatedAt}` : ""]
    .filter(Boolean)
    .join("     ");
  context.font = { color: { argb: MUTED_ON_INK }, name: "Calibri", size: 9 };
  context.alignment = { horizontal: "center", vertical: "middle" };

  band(5, 6); // bottom air
  // A single hairline of accent, full width — a rule, not a slab.
  for (let c = 1; c <= cols; c += 1) {
    sheet.getCell(5, c).border = { bottom: rule(ACCENT, "medium") };
  }

}

/**
 * The summary strip: sales units and stock FOR EVERY PRODUCT, at the top of the sheet.
 *
 * Replaces the old four cards. Counting products and regions told the reader nothing they could act
 * on — "26 products" is trivia — whereas per-product units and stock is the question the whole
 * report exists to answer, answered before you scroll.
 *
 * Banded 11 products per group so it scales: two products stay roomy, twenty-two wrap into a second
 * band rather than shrinking to unreadable columns or running past the page width.
 *
 * Every figure is a live SUM over that product's own TOTAL cell, so a product is counted exactly
 * once — a product code belongs to one line and therefore appears in exactly one block.
 */
function writeProductStrip(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  products: Array<{ label: string; units: string; stock: string }>,
  cols: number,
): number {
  if (products.length === 0) return startRow;
  const perBand = cols - 1;
  let row = startRow;

  for (let offset = 0; offset < products.length; offset += perBand) {
    const band = products.slice(offset, offset + perBand);
    const nameRow = sheet.getRow(row);
    const unitsRow = sheet.getRow(row + 1);
    const stockRow = sheet.getRow(row + 2);

    ([
      [nameRow, "", BONE],
      [unitsRow, "SALES UNITS", CREAM],
      [stockRow, "STOCK UNITS", CREAM_ALT],
    ] as const).forEach(([target, label, fill]) => {
      const c = target.getCell(1);
      c.value = label;
      c.font = { bold: true, color: { argb: MUTED_WARM }, name: "Calibri", size: 7.5 };
      c.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
      c.alignment = { horizontal: "center", vertical: "middle" };
    });

    band.forEach((product, index) => {
      const col = 2 + index;
      const name = nameRow.getCell(col);
      name.value = product.label;
      name.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 8 };
      name.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
      name.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      name.border = { bottom: rule(INK_SOFT), ...(index > 0 ? { left: rule(HAIRLINE) } : {}) };

      ([
        [unitsRow, product.units, CREAM, INK, 11] as const,
        [stockRow, product.stock, CREAM_ALT, INK_SOFT, 10] as const,
      ]).forEach(([target, ref, fill, colour, size]) => {
        const c = target.getCell(col);
        // Mirrors the product's TOTAL cell, so editing the grid moves this too.
        if (ref) c.value = { formula: ref, result: 0 };
        c.numFmt = UNITS_DASH_FMT;
        c.font = { bold: true, color: { argb: colour }, name: "Calibri", size };
        c.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
        c.alignment = { horizontal: "center", vertical: "middle" };
        if (index > 0) c.border = { left: rule(HAIRLINE) };
      });
    });

    nameRow.height = 24;
    unitsRow.height = 20;
    stockRow.height = 18;
    row += 3;
  }
  sheet.getRow(row).height = 10; // air before the first table
  return row + 1;
}

/** A line only splits at all once some family is bigger than this. */
const FAMILY_SPLIT_THRESHOLD = 2;

// ── Page geometry and palette ─────────────────────────────────────────────────
// The page is a FIXED width so every table lines up: Region + 5 products x (Units, Stock) = column K.
// Narrower tables stretch to fill it rather than ending raggedly — see spanPlan().
const PAGE_PRODUCTS = 5;
/** The data grid: region label + 5 products x (Units, Stock) — A..K, exactly as agreed. */
const GRID_COLS = 1 + PAGE_PRODUCTS * 2; // 11 = column K
/** One further column for the trend sparkline, so the grid itself still stops at K. */
const PAGE_COLS = GRID_COLS + 1; // 12 = column L

// ── Palette ───────────────────────────────────────────────────────────────────
// One warm family, deliberately narrow. The previous pass used black + slate + amber + orange +
// grey-blue zebra all at once, which is why it read as decorated rather than designed.
// ONE dark anchor per block, everything else quiet. The previous pass put clay on the product header
// AND the total row — two heavy bands per block, six blocks deep, plus an ink title above each. That
// stacking is what read as noise. Now: ink names the block, clay closes it, and the middle breathes.
const INK = "FF14110F"; // near-black, warm — masthead and block titles ONLY
const INK_SOFT = "FF3D3733"; // body text
const MUTED_WARM = "FF9A8F86"; // secondary text on cream
const MUTED_ON_INK = "FFB9AFA5"; // secondary text on the dark band
const CREAM = "FFFDFBF7"; // page ground — never plain white
const CREAM_ALT = "FFF9F5EF"; // alternating row tint, barely there
const BONE = "FFEFE7DB"; // column-header ground — warm and light, not another dark band
const HAIRLINE = "FFE4DBCE"; // the only rule colour used inside tables
const ACCENT = "FFF97316"; // Phoenix orange — the accent rule and nothing else
const CLAY = "FF7C2D12"; // total rows: the single dark close to each block
/** Data bars sit UNDER the numbers, so they are desaturated — full orange fought the type. */
const BAR_UNITS = "FFE9A178";
const BAR_STOCK = "FFDCC9B6";
/**
 * The one semantic colour in the workbook, and it exists only on the Month vs Target tab.
 *
 * Everywhere else a figure is just a quantity, so the warm family carries it. An achievement
 * percentage is the single place a reader is asking a yes/no question — did this area make its
 * number — and answering that in clay-versus-clay would make him do arithmetic the sheet is
 * supposed to have done for him. CLAY already reads as "short"; this is its counterpart.
 */
const GOOD = "FF15803D";

/** Zeros print as an en-dash. A grid of literal 0s is the loudest amateur tell in a report. */
const UNITS_DASH_FMT = '#,##0;-#,##0;"–"';

/**
 * A sparkline drawn with block characters.
 *
 * ExcelJS cannot write native sparklines — they are an Excel 2010 `x14` extension — and hand-rolling
 * that XML is precisely the class of "exotic" feature that has made this repo's workbooks trigger
 * Excel's repair prompt before. Block glyphs render everywhere, survive a copy-paste, and print.
 *
 * Scaled against the region's own peak, so the shape reads as "this region's own trajectory", not as
 * a comparison against a bigger region that would flatten it to nothing.
 */
const SPARK_GLYPHS = "▁▂▃▄▅▆▇█";
export function sparkline(series: number[]): string {
  if (series.length === 0) return "";
  const peak = Math.max(...series);
  if (peak <= 0) return SPARK_GLYPHS[0].repeat(series.length);
  return series
    .map((value) => {
      const step = Math.round((Math.max(0, value) / peak) * (SPARK_GLYPHS.length - 1));
      return SPARK_GLYPHS[Math.min(SPARK_GLYPHS.length - 1, step)];
    })
    .join("");
}

const rule = (color: string, style: "thin" | "medium" | "thick" = "thin") => ({ color: { argb: color }, style });

/**
 * Conditional-format priorities must be unique WITHIN a sheet — two rules sharing one is a known
 * cause of Excel's "we found a problem with some content" repair prompt on this repo's exports.
 */
const cfPriorityBySheet = new WeakMap<ExcelJS.Worksheet, number>();
function nextCfPriority(sheet: ExcelJS.Worksheet): number {
  const next = (cfPriorityBySheet.get(sheet) ?? 0) + 1;
  cfPriorityBySheet.set(sheet, next);
  return next;
}

/**
 * Column spans for one block's 2N value cells across the page's N*2 available columns.
 *
 * A table with two products would otherwise stop at column E while its neighbour runs to K, which
 * is what made the page look ragged. Each cell is merged across a tailored span so every block ends
 * on the same column; the remainder is handed to the leftmost cells so the widths stay near-equal.
 */
export function spanPlan(cellCount: number, availableCols: number): number[] {
  if (cellCount <= 0) return [];
  // Never zero. A zero-width span makes two cells resolve to the SAME column, so the later product
  // silently overwrites the earlier one and the last pair lands on the trend column. Callers keep
  // cellCount within the page (splitLineIntoFamilyBlocks caps every table at PAGE_PRODUCTS), so this
  // is the backstop for that invariant rather than a layout mode anyone should rely on.
  const base = Math.max(1, Math.floor(availableCols / cellCount));
  const remainder = Math.max(0, availableCols - base * cellCount);
  return Array.from({ length: cellCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Split a line into tables that are neither too WIDE nor too LONG.
 *
 * Owner's rule, refined: do not hand every family its own table — that makes the sheet endlessly
 * long. Instead take the LONGEST family as the width cap (CNS: Tebofortin, 5 concentrations here =
 * columns B..K) and then PACK the smaller families together, up to that cap, so short families ride
 * along in one table rather than each getting a header of its own.
 *
 * A family is never split across two tables — that is the whole point of grouping by family.
 *
 * A family that fills more than HALF the cap gets its own table; everything smaller is collected
 * together. Pure first-fit packing was tighter on paper but read badly: it filled Conviban's spare
 * slot with Dolabactin, stranding Dopaminict in a third table. The owner wants the short families
 * kept together — Rispadex + Dolabactin + Dopaminict in one — and the long ones standing alone.
 *
 * Grouping is on the family NAME. family_code is not unique — "DO" covers both Dopaminict and
 * Dolabactin — so keying on the code would silently merge two unrelated families into one table.
 */
export function splitLineIntoFamilyBlocks(
  lineRows: WeeklyFactExportRow[],
): Array<{ label: string; rows: WeeklyFactExportRow[] }> {
  const line = normalizeLine(lineRows[0]?.line) || "Line";

  // A line that already fits the page is ONE table, plainly named. This also replaces the old
  // "no family bigger than 2 -> one table" shortcut, which had no width limit at all: a line with
  // eight single-product families sailed past it into a table eight products wide.
  const totalProducts = new Set(lineRows.map((r) => r.productCode)).size;
  if (totalProducts <= PAGE_PRODUCTS) return [{ label: line, rows: lineRows }];

  const byFamily = new Map<string, WeeklyFactExportRow[]>();
  const productsPerFamily = new Map<string, Set<string>>();
  const unitsByProduct = new Map<string, number>();
  for (const row of lineRows) {
    // A product the master gave no family still has to appear — never drop it off the report.
    const family = (row.family ?? "").trim() || "Other";
    const bucket = byFamily.get(family);
    if (bucket) bucket.push(row);
    else byFamily.set(family, [row]);
    const codes = productsPerFamily.get(family) ?? new Set<string>();
    codes.add(row.productCode);
    productsPerFamily.set(family, codes);
    unitsByProduct.set(row.productCode, (unitsByProduct.get(row.productCode) ?? 0) + row.salesUnits);
  }

  // The cap is the longest family's width, as agreed — but never wider than the page. Those two
  // agree today only by coincidence: Tebofortin has SEVEN concentrations in the master, so an
  // uncapped rule builds a table 15 columns wide, well past the K/L edge he fixed.
  //
  // When no family is long enough to set a meaningful cap, the page itself is the cap.
  const rawCap = Math.max(...[...productsPerFamily.values()].map((codes) => codes.size), 1);
  const cap = rawCap <= FAMILY_SPLIT_THRESHOLD ? PAGE_PRODUCTS : Math.min(rawCap, PAGE_PRODUCTS);

  // A family wider than the page is the one case where it cannot stay whole. It is split into
  // numbered parts, biggest sellers first, so the reader can see it was divided rather than
  // wondering which concentrations went missing.
  type Chunk = { label: string; size: number; rows: WeeklyFactExportRow[] };
  const chunks: Chunk[] = [];
  for (const [family, rows] of byFamily) {
    const codes = [...(productsPerFamily.get(family) ?? [])].sort(
      (a, z) => (unitsByProduct.get(z) ?? 0) - (unitsByProduct.get(a) ?? 0) || a.localeCompare(z),
    );
    if (codes.length <= PAGE_PRODUCTS) {
      chunks.push({ label: family, size: codes.length, rows });
      continue;
    }
    const parts = Math.ceil(codes.length / PAGE_PRODUCTS);
    for (let part = 0; part < parts; part += 1) {
      const slice = new Set(codes.slice(part * PAGE_PRODUCTS, (part + 1) * PAGE_PRODUCTS));
      chunks.push({
        label: `${family} (${part + 1} of ${parts})`,
        size: slice.size,
        rows: rows.filter((row) => slice.has(row.productCode)),
      });
    }
  }
  chunks.sort((a, z) => z.size - a.size || sumRows(z.rows).salesUnits - sumRows(a.rows).salesUnits);

  const bins: Array<{ labels: string[]; width: number; rows: WeeklyFactExportRow[] }> = [];
  const openBin = () => {
    const bin = { labels: [] as string[], width: 0, rows: [] as WeeklyFactExportRow[] };
    bins.push(bin);
    return bin;
  };
  const place = (bin: (typeof bins)[number], chunk: Chunk) => {
    bin.labels.push(chunk.label);
    bin.width += chunk.size;
    bin.rows.push(...chunk.rows);
  };

  let shared: (typeof bins)[number] | null = null;
  for (const chunk of chunks) {
    // A long family owns its table; short ones share, opening a new shared table when full.
    if (chunk.size * 2 > cap) {
      place(openBin(), chunk);
      continue;
    }
    if (!shared || shared.width + chunk.size > cap) shared = openBin();
    place(shared, chunk);
  }

  return bins.map((bin) => ({ label: `${line} — ${bin.labels.join(" + ")}`, rows: bin.rows }));
}

/**
 * One line's region x product matrix. Returns the next free row so blocks can stack.
 *
 * Regions need no new mapping — every fact row already carries region_code/region_name, resolved at
 * IMPORT time from the weekly branch->region mapping (branch-region-map.ts). Rows follow the Monthly
 * Closing sequence so the reader sees the hierarchy they already know from that report.
 *
 * The product axis comes from the fact rows, NEVER from the product master: factRows are already
 * access-scope redacted, so restricted products and the Head Office line are absent for viewers who
 * must not see them. Enumerating the master would print those names.
 */
function writeRegionProductBlock(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  lineLabel: string,
  rows: WeeklyFactExportRow[],
  /** Same scope but every week of the cycle month, so each region gets a trajectory to draw. */
  trendRows: WeeklyFactExportRow[],
): {
  nextRow: number;
  unitsRefs: string[];
  stockRefs: string[];
  productRefs: Array<{ label: string; units: string; stock: string }>;
} {
  const productCodes = new Set(rows.map((r) => r.productCode));
  const weeksInScope = [...new Set(trendRows.map((r) => r.weekStart).filter(Boolean))].sort();
  const products = rollup(rows, (r) => r.productCode, (r) => r.productName || r.productCode).sort(
    (a, z) => z.salesUnits - a.salesUnits || a.label.localeCompare(z.label),
  );
  // A branch with no region mapping still sold something. It gets a NAMED row rather than a blank
  // one — the standing rule is count it and flag it, never let it vanish or show as an empty label.
  const regions = rollup(
    rows,
    (r) => normalizeRegion(r.regionCode),
    (r) => r.regionName || r.regionCode || "No region mapped",
  ).sort(
    (a, z) => monthlyClosingRegionRank(a.key) - monthlyClosingRegionRank(z.key) || a.key.localeCompare(z.key),
  );

  const cell = new Map<string, SummaryTotals>();
  for (const r of rows) {
    const key = `${normalizeRegion(r.regionCode)}||${r.productCode}`;
    const current = cell.get(key) ?? { ...ZERO };
    addInto(current, r);
    cell.set(key, current);
  }


  // EVERY block ends on the same column. A two-product table would otherwise stop at column E beside
  // a five-product one running to K, which is what made the page look ragged. Each value cell is
  // merged across a tailored span so all blocks finish flush at K.
  const spans = spanPlan(products.length * 2, GRID_COLS - 1);
  const firstColOf: number[] = [];
  let cursor = 2;
  for (const span of spans) {
    firstColOf.push(cursor);
    cursor += span;
  }
  const cellRange = (cellIndex: number) => ({
    from: firstColOf[cellIndex],
    to: firstColOf[cellIndex] + spans[cellIndex] - 1,
  });
  /** Write one merged value cell of the grid. */
  const put = (excelRow: ExcelJS.Row, cellIndex: number, style: (c: ExcelJS.Cell) => void) => {
    const { from, to } = cellRange(cellIndex);
    if (to > from) sheet.mergeCells(excelRow.number, from, excelRow.number, to);
    const c = excelRow.getCell(from);
    style(c);
    return c;
  };

  let row = startRow;

  // Block heading carries the masthead's own treatment — same ink ground, same light face — so the
  // page reads as one document rather than a banner followed by unrelated tables.
  sheet.mergeCells(row, 1, row, PAGE_COLS);
  const titleCell = sheet.getCell(row, 1);
  titleCell.value = lineLabel;
  titleCell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri Light", size: 14 };
  titleCell.fill = { fgColor: { argb: INK }, pattern: "solid", type: "pattern" };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(row).height = 24;
  row += 1;

  const productHeader = sheet.getRow(row);
  const subHeader = sheet.getRow(row + 1);

  // REGION spans BOTH header rows — one label for the axis, not a word floating above an empty cell.
  sheet.mergeCells(row, 1, row + 1, 1);
  const regionHead = productHeader.getCell(1);
  regionHead.value = "REGION";
  regionHead.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 9 };
  regionHead.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
  regionHead.alignment = { horizontal: "center", vertical: "middle" };
  regionHead.border = { bottom: rule(INK_SOFT) };
  sheet.getColumn(1).width = 24;

  // TREND spans both header rows too, closing the grid on the right.
  sheet.mergeCells(row, PAGE_COLS, row + 1, PAGE_COLS);
  const trendHead = productHeader.getCell(PAGE_COLS);
  trendHead.value = "TREND";
  trendHead.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 9 };
  trendHead.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
  trendHead.alignment = { horizontal: "center", vertical: "middle" };
  trendHead.border = { bottom: rule(INK_SOFT), left: rule(HAIRLINE) };
  sheet.getColumn(PAGE_COLS).width = 16;

  products.forEach((product, index) => {
    const unitsCell = index * 2;
    const stockCell = unitsCell + 1;
    const from = cellRange(unitsCell).from;
    const to = cellRange(stockCell).to;
    sheet.mergeCells(row, from, row, to);
    const head = productHeader.getCell(from);
    head.value = product.label;
    // Warm bone, ink type. A second dark band here fought the block title above and the total below.
    head.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 10.5 };
    head.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
    head.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    // Hairline between products, so the eye can separate them without a full grid.
    if (index > 0) head.border = { left: rule(HAIRLINE) };

    ([["UNITS", unitsCell], ["STOCK", stockCell]] as const).forEach(([label, cellIndex]) => {
      put(subHeader, cellIndex, (c) => {
        c.value = label;
        c.font = { bold: true, color: { argb: MUTED_WARM }, name: "Calibri", size: 7.5 };
        c.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
        c.alignment = { horizontal: "center", vertical: "middle" };
        c.border = { bottom: rule(INK_SOFT), ...(cellIndex === unitsCell && index > 0 ? { left: rule(HAIRLINE) } : {}) };
      });
    });
  });
  for (let c = 2; c <= PAGE_COLS; c += 1) sheet.getColumn(c).width = 13;
  productHeader.height = 26;
  subHeader.height = 14;
  row += 2;

  const firstDataRow = row;
  regions.forEach((region, regionIndex) => {
    const excelRow = sheet.getRow(row);
    const tint = regionIndex % 2 === 1 ? CREAM_ALT : CREAM;
    const label = excelRow.getCell(1);
    label.value = region.label;
    label.font = { color: { argb: INK_SOFT }, name: "Calibri", size: 10.5 };
    label.alignment = { horizontal: "center", vertical: "middle" };
    label.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
    products.forEach((product, index) => {
      const totals = cell.get(`${region.key}||${product.key}`) ?? ZERO;
      [totals.salesUnits, totals.stockUnits].forEach((value, offset) => {
        const cellIndex = index * 2 + offset;
        put(excelRow, cellIndex, (c) => {
          c.value = value;
          c.numFmt = UNITS_DASH_FMT;
          c.font = { color: { argb: value === 0 ? MUTED_WARM : INK_SOFT }, name: "Calibri", size: 10.5 };
          c.alignment = { horizontal: "center", vertical: "middle" };
          c.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
          if (offset === 0 && index > 0) c.border = { left: rule(HAIRLINE) };
        });
      });
    });
    // Each region's own trajectory across the weeks of this cycle month.
    const series = weeksInScope.map((week) =>
      trendRows
        .filter(
          (r) =>
            r.weekStart === week &&
            normalizeRegion(r.regionCode) === region.key &&
            productCodes.has(r.productCode),
        )
        .reduce((sum, r) => sum + r.salesUnits, 0),
    );
    const trendCell = excelRow.getCell(PAGE_COLS);
    trendCell.value = sparkline(series);
    trendCell.font = { color: { argb: ACCENT }, name: "Segoe UI Symbol", size: 11 };
    trendCell.alignment = { horizontal: "center", vertical: "middle" };
    trendCell.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
    trendCell.border = { left: rule(HAIRLINE) };

    excelRow.height = 17;
    row += 1;
  });
  const lastDataRow = row - 1;

  // IN-CELL VISUALISATION. Every figure carries a bar showing its size against the rest of its own
  // column, so a region's share is readable at a glance instead of by comparing digits.
  //
  // Scaled PER BLOCK and PER PRODUCT: a bar spanning the whole sheet would be meaningless when
  // Lacto Basic runs to five figures and Dopaminect to two. Units get the Phoenix orange, stock a
  // muted clay so the two never compete. Each rule takes its own priority — duplicates are what
  // make Excel offer to "repair" a workbook.
  if (lastDataRow >= firstDataRow) {
    products.forEach((product, index) => {
      [
        [index * 2, BAR_UNITS] as const,
        [index * 2 + 1, BAR_STOCK] as const,
      ].forEach(([cellIndex, colour]) => {
        const column = sheet.getColumn(cellRange(cellIndex).from).letter;
        // Built as a variable, not an inline literal: ExcelJS's DataBarRuleType omits `color`, so a
        // direct literal trips excess-property checking. The shared kit does the same.
        const bar = {
          cfvo: [{ type: "num" as const, value: 0 }, { type: "max" as const }],
          color: { argb: colour },
          gradient: true,
          priority: nextCfPriority(sheet),
          showValue: true,
          type: "dataBar" as const,
        };
        try {
          sheet.addConditionalFormatting({ ref: `${column}${firstDataRow}:${column}${lastDataRow}`, rules: [bar] });
        } catch {
          // Data bars are cosmetics — never fail an export over one.
        }
      });
    });
  }

  const totalRow = sheet.getRow(row);
  totalRow.height = 22;
  const totalLabel = totalRow.getCell(1);
  totalLabel.value = "TOTAL";
  totalLabel.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10 };
  totalLabel.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
  totalLabel.alignment = { horizontal: "center", vertical: "middle" };
  totalLabel.border = { top: rule(ACCENT, "medium") };

  // LIVE FORMULAS, not baked numbers — edit a region cell and the total follows.
  //
  // The cached `result` is carried too, but treat it as a courtesy for viewers that never calculate:
  // Excel RECALCULATES this workbook on open (fullCalcOnLoad), so the formula is what will actually
  // be displayed. That is precisely how the Closing Matrix lost 18 of 22 region subtotals once — a
  // correct cached value sitting on a formula whose range was wrong. The range below is the block's
  // own data rows and nothing else.
  const unitsRefs: string[] = [];
  const stockRefs: string[] = [];
  // Per-product cell addresses for the summary strip. A product code belongs to exactly one line —
  // official_line comes from the master — so it appears in exactly one block and cannot be counted twice.
  const productRefs: Array<{ label: string; units: string; stock: string }> = [];
  products.forEach((product, index) => {
    [product.salesUnits, product.stockUnits].forEach((value, offset) => {
      const cellIndex = index * 2 + offset;
      const letter = sheet.getColumn(cellRange(cellIndex).from).letter;
      const written = put(totalRow, cellIndex, (c) => {
        c.value =
          lastDataRow >= firstDataRow
            ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result: value }
            : value;
        c.numFmt = UNITS_DASH_FMT;
        c.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10.5 };
        c.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
        c.alignment = { horizontal: "center", vertical: "middle" };
        c.border = { top: rule(ACCENT, "medium") };
      });
      (offset === 0 ? unitsRefs : stockRefs).push(`${written.address}`);
      if (offset === 0) productRefs.push({ label: product.label, units: written.address, stock: "" });
      else productRefs[productRefs.length - 1].stock = written.address;
    });
  });
  // A clear gap after each block; whitespace is what separates the tables, not more ink.
  sheet.getRow(row + 1).height = 12;
  return { nextRow: row + 2, unitsRefs, stockRefs, productRefs };
}

/**
 * Final pass: lay the cream ground under anything unpainted and frame the page.
 *
 * Runs last so it can fill the gaps between blocks without overwriting a single styled cell — a
 * plain white sheet read as a raw dump rather than a report.
 */
function dressPage(sheet: ExcelJS.Worksheet, lastRow: number, cols: number): void {
  for (let r = 1; r <= lastRow; r += 1) {
    const excelRow = sheet.getRow(r);
    for (let c = 1; c <= cols; c += 1) {
      const cell = excelRow.getCell(c);
      if (!cell.fill) cell.fill = { fgColor: { argb: CREAM }, pattern: "solid", type: "pattern" };
    }
    // Side rails, thin and ink-coloured — a frame should be felt, not seen.
    excelRow.getCell(1).border = { ...(excelRow.getCell(1).border ?? {}), left: rule(INK) };
    excelRow.getCell(cols).border = { ...(excelRow.getCell(cols).border ?? {}), right: rule(INK) };
  }
  for (let c = 1; c <= cols; c += 1) {
    const cell = sheet.getRow(lastRow).getCell(c);
    cell.border = { ...(cell.border ?? {}), bottom: rule(INK) };
  }

  // Print like a document, not a spreadsheet dump: one page wide, landscape, headers repeated.
  sheet.pageSetup = {
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    orientation: "landscape",
    horizontalCentered: true,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    printTitlesRow: "1:8",
  };
  sheet.headerFooter = { oddFooter: "&L&\"Calibri\"&8&K9A8F86Phoenix Workforce&C&8&K9A8F86&P / &N" };
}

// ── Tab 2: Weekly by Manager ──────────────────────────────────────────────────
//
// Same grammar as Tab 1 — cream ground, ONE ink anchor per section, bone headers, a clay close, and
// every figure traceable to a named PRODUCT. What changes is the axis. Tab 1 answers "which REGION
// sold it"; Tab 2 answers "which of MY branches sold it", so rows are Distributor x Branch and the
// sections are managers.
//
// Two label columns instead of one, so the grid runs A..L with the trend at M. Flush is a
// within-sheet property: every table on THIS sheet ends on the same column, exactly as every table
// on Tab 1 ends on K. The 5-product cap is unchanged, so splitLineIntoFamilyBlocks is reused as-is.

/** The area name. One label column, so this sheet is exactly as wide as Tab 1. */
const MGR_LABEL_COLS = 1;
/** Label + 5 products x (Units, Stock) — A..K. */
const MGR_GRID_COLS = MGR_LABEL_COLS + PAGE_PRODUCTS * 2; // 11 = column K
/** One more for the trend sparkline, so the grid itself still stops at K. */
const MGR_PAGE_COLS = MGR_GRID_COLS + 1; // 12 = column L

/**
 * Rows that carry no area still have to appear, and have to say why.
 *
 * 98% of the unmapped VOLUME is deliberate: a key account, chain, wholesale depot, warehouse or
 * governorate customer book serves several areas at once, so no single area is correct for it.
 * Dropping those rows would hide roughly four fifths of the units; leaving them unlabelled would be
 * worse. They get their own named row at the bottom of each manager's table.
 */
const NO_AREA_LABEL = "Not area-mapped (key accounts, chains, wholesale)";

/**
 * Where a manager's section sits on the page.
 *
 * compareManagerBuckets orders real managers ALPHABETICALLY, which puts Cairo next to Zagazig and
 * bears no relation to how the owner reads a report. Sections follow the Monthly Closing sequence
 * instead (CA, GZ, UE, UE-1, UE-2, AB, D1, D2, OT) — the same order Tab 1's region rows use, and the
 * one he already knows from that report.
 *
 * A manager seat is (line, region), so a section has exactly one region and the rank is unambiguous.
 * The CEO / vacant / unmapped buckets keep their kind order and fall to the bottom regardless.
 */
function managerRegionRank(group: ManagerGroup): number {
  let best = Number.POSITIVE_INFINITY;
  for (const row of group.rows) {
    best = Math.min(best, monthlyClosingRegionRank(normalizeRegion(row.regionCode)));
  }
  return Number.isFinite(best) ? best : Number.MAX_SAFE_INTEGER;
}

function buildManagerSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: WeeklyFactExportRow[],
  index: WeeklyManagerIndex,
  lineLabel: string,
  periodLabel: string,
  generatedAt: string,
  /** Same scope, every week of the cycle month — the series each area's sparkline draws. */
  trendRows: WeeklyFactExportRow[],
  /** area_code -> area name. Owner rule: show the name, never the code. */
  areaNames: Map<string, string>,
  /**
   * Which cut this sheet shows. Both are built from the same rows by the same writer:
   *   "area"   — what the manager OWNS and is measured on.
   *   "branch" — where he actually has to send someone.
   */
  rowAxis: "area" | "branch",
): void {
  const sheet = workbook.addWorksheet(name);
  const AXIS = rowAxis === "area" ? "Manager × Area × Product" : "Manager × Branch × Product";
  // COLLAPSIBLE. Detail rows sit at outline level 1 and each manager's TOTAL row closes the group
  // below it, so the "1" button in Excel's left gutter collapses the sheet to one line per manager
  // and "2" opens the areas back up. Left EXPANDED on open — a sheet that opens collapsed reads as
  // empty until you find the buttons.
  //
  // DO NOT SET `outlineProperties` HERE. It reads like the natural way to declare summaryBelow, and
  // it produces a workbook Excel refuses to open.
  //
  // ExcelJS 4.4.0 renders the children of <sheetPr> in the wrong order — see
  // lib/xlsx/xform/sheet/sheet-properties-xform.js, render(): pageSetUpPr is emitted before
  // outlinePr — but OOXML's CT_SheetPr is a SEQUENCE: tabColor -> outlinePr -> pageSetUpPr.
  // dressPage sets pageSetup.fitToPage, so asking for outlineProperties as well emits
  //     <sheetPr><pageSetUpPr fitToPage="1"/><outlinePr .../></sheetPr>
  // which is schema-invalid. Excel reports "Load error. Line 2, column 0" against THIS sheet and
  // offers to repair the file. The XML is well-formed, so no parser catches it; Tab 1 is unaffected
  // only because it has no outline.
  //
  // Nothing is lost: summaryBelow already DEFAULTS to true in Excel, which is exactly this layout —
  // each manager's TOTAL row closes the group beneath its detail. The row-level outlineLevel set
  // further down is what actually creates the collapsible groups.
  //
  // outlineLevelRow must still sit above the deepest level in use: ExcelJS derives a row's
  // `collapsed` flag as `outlineLevel >= properties.outlineLevelRow` and offers no setter, so the
  // default of 0 marks every level-1 row collapsed while leaving it visible.
  sheet.properties.outlineLevelRow = 2;

  if (rows.length === 0) {
    premiumMasthead(sheet, MGR_PAGE_COLS, lineLabel, "No data", periodLabel, generatedAt, AXIS);
    sheet.getCell(7, 1).value = "No validated weekly sales for the selected period.";
    sheet.views = [{ showGridLines: false }];
    return;
  }

  const sheetDates = [...new Set(rows.map((r) => r.weekStart).filter(Boolean))].sort();
  const coverage =
    sheetDates.length === 1
      ? `Sheet of ${sheetDates[0]}`
      : `Sheets ${sheetDates[0]} to ${sheetDates[sheetDates.length - 1]}`;
  premiumMasthead(sheet, MGR_PAGE_COLS, lineLabel, coverage, periodLabel, generatedAt, AXIS);

  // Rank lines the way Tab 1 does — biggest first — so a manager's line does not jump around
  // between the two sheets. Within a line, geography decides.
  const unitsByLine = new Map<string, number>();
  for (const r of rows) {
    const key = normalizeLine(r.line).toLowerCase();
    unitsByLine.set(key, (unitsByLine.get(key) ?? 0) + r.salesUnits);
  }
  const lineRank = (group: ManagerGroup) => {
    const line = normalizeLine(group.rows[0]?.line).toLowerCase();
    return -(unitsByLine.get(line) ?? 0);
  };

  const groups = groupRowsByManager(rows, index).sort(
    (a, z) =>
      a.bucket.sortOrder - z.bucket.sortOrder ||
      lineRank(a) - lineRank(z) ||
      managerRegionRank(a) - managerRegionRank(z) ||
      a.bucket.label.localeCompare(z.bucket.label),
  );

  // THE PRODUCT AXIS IS COMPUTED ONCE FOR THE WHOLE SHEET, and every manager then renders the SAME
  // columns in the SAME order. Deriving it per manager made neighbouring sections disagree — one
  // manager's third CNS table read "Rispadex + Dopaminict", the next "Rispadex + Dolabactin" — so no
  // two managers could be compared by eye, which is most of what this tab is for. Seeing all three
  // families at once also restores the grouping he asked for: Rispadex, Dopaminict and Dolabactin
  // travel together.
  const unitsByProduct = new Map<string, number>();
  for (const r of rows) unitsByProduct.set(r.productCode, (unitsByProduct.get(r.productCode) ?? 0) + r.salesUnits);
  const axisOf = (blockRows: WeeklyFactExportRow[]) => {
    const labels = new Map<string, string>();
    for (const r of blockRows) if (!labels.has(r.productCode)) labels.set(r.productCode, r.productName || r.productCode);
    return [...labels.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort(
        (a, z) =>
          (unitsByProduct.get(z.key) ?? 0) - (unitsByProduct.get(a.key) ?? 0) || a.label.localeCompare(z.label),
      );
  };

  const linesPresent = [...new Set(rows.map((r) => normalizeLine(r.line)).filter(Boolean))];
  const unlinedRows = rows.filter((r) => !normalizeLine(r.line));
  const blockPlan: Array<{ line: string; label: string; axis: Array<{ key: string; label: string }>; codes: Set<string> }> = [];
  const planLine = (line: string, source: WeeklyFactExportRow[]) => {
    for (const block of splitLineIntoFamilyBlocks(source)) {
      const axis = axisOf(block.rows);
      blockPlan.push({ line, label: block.label, axis, codes: new Set(axis.map((p) => p.key)) });
    }
  };
  for (const line of linesPresent) planLine(line.toLowerCase(), rows.filter((r) => sameLine(r.line, line)));
  // Rows the master left without a line still sold something. Count it and show it — never let a
  // sales row disappear because a reference field was blank.
  if (unlinedRows.length > 0) planLine("", unlinedRows);

  // The strip sits under the masthead but can only be FILLED once the sections below exist and their
  // total cells have addresses. Reserve its rows now, write the sections, then come back.
  const productCount = new Set(rows.map((r) => r.productCode)).size;
  const stripRows = Math.ceil(productCount / (MGR_PAGE_COLS - 1)) * 3 + 1;
  const stripStart = 6;
  let row = stripStart + stripRows;

  // A product appears once per MANAGER section, and manager sections partition the rows, so summing
  // one product's section totals counts it exactly once. This is why the strip references the
  // sections' TOTAL cells and never the area cells — adding both would count everything twice.
  const refsByProduct = new Map<string, { label: string; units: string[]; stock: string[] }>();

  for (const group of groups) {
    row = writeManagerBand(sheet, row, group.bucket);

    // A manager seat is one line, so this is normally that line's tables and nothing else. The
    // unmapped bucket can hold several lines, and a long line still splits by family.
    const groupLines = new Set(group.rows.map((r) => normalizeLine(r.line).toLowerCase()));
    const plans = blockPlan.filter((plan) => groupLines.has(plan.line));

    for (const plan of plans) {
      const blockRows = group.rows.filter((r) => plan.codes.has(r.productCode));
      // A family this manager sold none of would be a header and a row of dashes. Skip it.
      if (blockRows.length === 0) continue;
      const written = writeManagerAreaBlock(
        sheet,
        row,
        plans.length > 1 ? plan.label : null,
        plan.axis,
        blockRows,
        trendRows,
        `${group.bucket.label} — TOTAL`,
        areaNames,
        rowAxis,
      );
      for (const ref of written.productRefs) {
        const entry = refsByProduct.get(ref.code) ?? { label: ref.label, units: [], stock: [] };
        entry.units.push(ref.units);
        entry.stock.push(ref.stock);
        refsByProduct.set(ref.code, entry);
      }
      row = written.nextRow;
    }
    row += 1; // air between managers
  }

  // Fill the reserved strip, ordered like every other product axis in this workbook: biggest seller
  // first. Each figure is one SUM across that product's section totals — disjoint by construction.
  const strip = [...refsByProduct.entries()]
    .sort((a, z) => (unitsByProduct.get(z[0]) ?? 0) - (unitsByProduct.get(a[0]) ?? 0) || a[1].label.localeCompare(z[1].label))
    .map(([, entry]) => ({
      label: entry.label,
      units: `SUM(${entry.units.join(",")})`,
      stock: `SUM(${entry.stock.join(",")})`,
    }));
  writeProductStrip(sheet, stripStart, strip, MGR_PAGE_COLS);

  sheet.mergeCells(row, 1, row, MGR_PAGE_COLS);
  const footnote = sheet.getCell(row, 1);
  footnote.value =
    `${ATTRIBUTION_CAVEAT} Units are this sheet's own sale, de-cumulated. Unmapped products are ` +
    "excluded — an unmapped SKU double-counts against the real product it belongs to. Stock is a " +
    "point-in-time snapshot and is never summed across weeks; a branch can report stock without " +
    "sales, or sales without stock, and both are shown as the source reports them.";
  footnote.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9 };
  footnote.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sheet.getRow(row).height = 30;

  dressPage(sheet, row, MGR_PAGE_COLS);

  // Both label columns stay put while scrolling right; header rows differ per section, so freezing
  // rows would pin the first section's headers over every table below it.
  sheet.views = [{ state: "frozen", xSplit: MGR_LABEL_COLS, showGridLines: false }];
}

/**
 * The section anchor: the manager's name on ink, their scope and reporting line quietly beneath.
 *
 * Shared by Tab 2 and Tabs 3/4, which are different widths, so the span is a parameter.
 */
function writeManagerBand(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  bucket: WeeklyManagerBucket,
  cols: number = MGR_PAGE_COLS,
): number {
  sheet.mergeCells(startRow, 1, startRow, cols);
  const title = sheet.getCell(startRow, 1);
  title.value = bucket.label;
  title.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri Light", size: 14 };
  title.fill = { fgColor: { argb: INK }, pattern: "solid", type: "pattern" };
  title.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(startRow).height = 24;

  // Scope and reporting line sit on cream, not on a second dark band — one anchor per section.
  const caption = [bucket.scopeLabel, reportingLine(bucket)].filter(Boolean).join("   ·   ");
  if (!caption) return startRow + 1;
  sheet.mergeCells(startRow + 1, 1, startRow + 1, cols);
  const sub = sheet.getCell(startRow + 1, 1);
  sub.value = caption;
  sub.font = { color: { argb: MUTED_WARM }, name: "Calibri", size: 8.5 };
  sub.fill = { fgColor: { argb: CREAM }, pattern: "solid", type: "pattern" };
  sub.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(startRow + 1).height = 15;
  return startRow + 2;
}

/**
 * One manager's AREA x product matrix. Returns the next free row so sections can stack.
 *
 * Rows are the manager's own areas, ordered by the org's area code so Dakahlia 1, 2, 3 read in the
 * order he knows them. Branch grain was the source file's shape, not his: a manager owns areas, and
 * a distributor branch can serve several of them.
 *
 * Rows carrying no area are NOT dropped — they collect in one named row at the bottom. That residue
 * is most of the volume (key accounts, chains, wholesale), so hiding it would understate every
 * manager by roughly four fifths.
 *
 * The product axis comes from the fact rows, NEVER from the product master: factRows are already
 * access-scope redacted, so restricted products and the Head Office line are absent for viewers who
 * must not see them. Enumerating the master would print those names.
 */
function writeManagerAreaBlock(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  /** Family label, only when this manager's line needed splitting. */
  subLabel: string | null,
  /** The sheet-wide column axis for this table, so every manager's grid lines up. */
  products: Array<{ key: string; label: string }>,
  rows: WeeklyFactExportRow[],
  trendRows: WeeklyFactExportRow[],
  totalLabel: string,
  /** area_code -> area name. Owner rule: show the name, never the code. */
  areaNames: Map<string, string>,
  /** Which cut of the same numbers this sheet shows: what he owns, or where he must send someone. */
  rowAxis: "area" | "branch",
): { nextRow: number; productRefs: Array<{ code: string; label: string; units: string; stock: string }> } {
  const productCodes = new Set(products.map((p) => p.key));
  const weeksInScope = [...new Set(trendRows.map((r) => r.weekStart).filter(Boolean))].sort();
  // This manager's own totals per product — the cached results behind the SUM formulas below.
  const productTotals = new Map<string, SummaryTotals>();
  for (const r of rows) {
    const current = productTotals.get(r.productCode) ?? { ...ZERO };
    addInto(current, r);
    productTotals.set(r.productCode, current);
  }

  // THE ROW AXIS IS A PARAMETER. A manager wants both cuts of the same numbers: by AREA, which is
  // what he owns and is measured on, and by BRANCH, which is where he actually has to send someone.
  // One writer serves both so the two sheets cannot drift apart in layout or arithmetic.
  const isArea = rowAxis === "area";
  const areaKey = (r: WeeklyFactExportRow) => (r.areaCode ?? "").trim().toUpperCase();
  const branchKey = (r: WeeklyFactExportRow) => `${r.distributorCode}||${r.branchCode || r.branchName}`;
  const rowKey = isArea ? areaKey : branchKey;

  const buckets = rollup(rows, rowKey, (r) =>
    isArea
      ? areaKey(r)
        ? (areaNames.get(areaKey(r)) ?? areaKey(r))
        : NO_AREA_LABEL
      : r.branchName || r.branchCode || "Unnamed branch",
  );

  // Areas sort by the org's own numbering (Dakahlia 1, 2, 3) — the order he reads them in — with the
  // unmapped residue last. Branches have no such numbering, so biggest seller first is the useful
  // order there.
  const ordered = isArea
    ? [...buckets].sort((a, z) => {
        if (!a.key) return 1;
        if (!z.key) return -1;
        return a.key.localeCompare(z.key, undefined, { numeric: true });
      })
    : [...buckets].sort(
        (a, z) => z.salesUnits - a.salesUnits || z.stockUnits - a.stockUnits || a.label.localeCompare(z.label),
      );

  const cell = new Map<string, SummaryTotals>();
  for (const r of rows) {
    const key = `${rowKey(r)}||${r.productCode}`;
    const current = cell.get(key) ?? { ...ZERO };
    addInto(current, r);
    cell.set(key, current);
  }

  // Every table on this sheet ends on the same column. A two-product table would otherwise stop at
  // column F beside a five-product one running to L. Each value cell is merged across a tailored
  // span so all of them finish flush.
  const spans = spanPlan(products.length * 2, MGR_GRID_COLS - MGR_LABEL_COLS);
  const firstColOf: number[] = [];
  let cursor = MGR_LABEL_COLS + 1;
  for (const span of spans) {
    firstColOf.push(cursor);
    cursor += span;
  }
  const cellRange = (i: number) => ({ from: firstColOf[i], to: firstColOf[i] + spans[i] - 1 });
  const put = (excelRow: ExcelJS.Row, i: number, style: (c: ExcelJS.Cell) => void) => {
    const { from, to } = cellRange(i);
    if (to > from) sheet.mergeCells(excelRow.number, from, excelRow.number, to);
    const c = excelRow.getCell(from);
    style(c);
    return c;
  };

  let row = startRow;

  // Family sub-title, when one manager's line needed more than one table. Deliberately quiet — the
  // manager band above is the section's only dark anchor.
  if (subLabel) {
    sheet.mergeCells(row, 1, row, MGR_PAGE_COLS);
    const c = sheet.getCell(row, 1);
    c.value = [...subLabel.toUpperCase()].join(" ");
    c.font = { bold: true, color: { argb: MUTED_WARM }, name: "Calibri", size: 8 };
    c.fill = { fgColor: { argb: CREAM }, pattern: "solid", type: "pattern" };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = { bottom: rule(HAIRLINE) };
    sheet.getRow(row).height = 16;
    sheet.getRow(row).outlineLevel = 1;
    row += 1;
  }

  const productHeader = sheet.getRow(row);
  const subHeader = sheet.getRow(row + 1);
  // Column headers belong to the detail, so collapsing leaves a clean manager list behind.
  productHeader.outlineLevel = 1;
  subHeader.outlineLevel = 1;

  // AREA spans both header rows — one label for the axis, not a word floating above an empty cell.
  sheet.mergeCells(row, 1, row + 1, 1);
  const areaHead = productHeader.getCell(1);
  areaHead.value = isArea ? "AREA" : "BRANCH";
  areaHead.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 9 };
  areaHead.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
  areaHead.alignment = { horizontal: "center", vertical: "middle" };
  areaHead.border = { bottom: rule(INK_SOFT) };
  sheet.getColumn(1).width = 34;

  sheet.mergeCells(row, MGR_PAGE_COLS, row + 1, MGR_PAGE_COLS);
  const trendHead = productHeader.getCell(MGR_PAGE_COLS);
  trendHead.value = "TREND";
  trendHead.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 9 };
  trendHead.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
  trendHead.alignment = { horizontal: "center", vertical: "middle" };
  trendHead.border = { bottom: rule(INK_SOFT), left: rule(HAIRLINE) };
  sheet.getColumn(MGR_PAGE_COLS).width = 16;

  products.forEach((product, index) => {
    const unitsCell = index * 2;
    const stockCell = unitsCell + 1;
    sheet.mergeCells(row, cellRange(unitsCell).from, row, cellRange(stockCell).to);
    const head = productHeader.getCell(cellRange(unitsCell).from);
    head.value = product.label;
    head.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 10.5 };
    head.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
    head.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    head.border = { left: rule(index > 0 ? HAIRLINE : INK_SOFT) };

    ([["UNITS", unitsCell], ["STOCK", stockCell]] as const).forEach(([label, i]) => {
      put(subHeader, i, (c) => {
        c.value = label;
        c.font = { bold: true, color: { argb: MUTED_WARM }, name: "Calibri", size: 7.5 };
        c.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
        c.alignment = { horizontal: "center", vertical: "middle" };
        c.border = { bottom: rule(INK_SOFT), ...(i === unitsCell ? { left: rule(index > 0 ? HAIRLINE : INK_SOFT) } : {}) };
      });
    });
  });
  for (let c = MGR_LABEL_COLS + 1; c < MGR_PAGE_COLS; c += 1) sheet.getColumn(c).width = 12;
  productHeader.height = 26;
  subHeader.height = 14;
  row += 2;

  const firstDataRow = row;
  ordered.forEach((bucket, bucketIndex) => {
    const excelRow = sheet.getRow(row);
    const tint = bucketIndex % 2 === 1 ? CREAM_ALT : CREAM;

    const label = excelRow.getCell(1);
    label.value = bucket.label;
    // The residue row is muted and italic so it never reads as a real area.
    label.font = bucket.key
      ? { color: { argb: INK_SOFT }, name: "Calibri", size: 10.5 }
      : { color: { argb: MUTED_WARM }, italic: true, name: "Calibri", size: 9.5 };
    label.alignment = { horizontal: "center", vertical: "middle" };
    label.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };

    products.forEach((product, index) => {
      const totals = cell.get(`${bucket.key}||${product.key}`) ?? ZERO;
      [totals.salesUnits, totals.stockUnits].forEach((value, offset) => {
        const i = index * 2 + offset;
        put(excelRow, i, (c) => {
          c.value = value;
          c.numFmt = UNITS_DASH_FMT;
          c.font = { color: { argb: value === 0 ? MUTED_WARM : INK_SOFT }, name: "Calibri", size: 10.5 };
          c.alignment = { horizontal: "center", vertical: "middle" };
          c.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
          if (offset === 0) c.border = { left: rule(index > 0 ? HAIRLINE : INK_SOFT) };
        });
      });
    });

    // This area's own trajectory across the weeks of the cycle month, for this table's products.
    const series = weeksInScope.map((week) =>
      trendRows
        .filter((r) => r.weekStart === week && rowKey(r) === bucket.key && productCodes.has(r.productCode))
        .reduce((sum, r) => sum + r.salesUnits, 0),
    );
    const trendCell = excelRow.getCell(MGR_PAGE_COLS);
    trendCell.value = sparkline(series);
    trendCell.font = { color: { argb: ACCENT }, name: "Segoe UI Symbol", size: 11 };
    trendCell.alignment = { horizontal: "center", vertical: "middle" };
    trendCell.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
    trendCell.border = { left: rule(HAIRLINE) };

    // Close every cell of the row with a hairline so the expanded matrix reads as a GRID. The
    // product separators are already vertical; this is the horizontal half of the same idea.
    for (let c = 1; c <= MGR_PAGE_COLS; c += 1) {
      const gridCell = excelRow.getCell(c);
      gridCell.border = { ...(gridCell.border ?? {}), bottom: rule(HAIRLINE) };
    }

    excelRow.height = 17;
    excelRow.outlineLevel = 1;
    row += 1;
  });
  const lastDataRow = row - 1;

  // In-cell bars, scaled per product within this manager's own table — a bar spanning the sheet
  // would be meaningless when one product runs to five figures and another to two. Skipped on very
  // short tables, where a bar says nothing a two-row comparison does not already show, and where the
  // rule count would otherwise multiply across every manager on the sheet.
  if (lastDataRow - firstDataRow >= 2) {
    products.forEach((product, index) => {
      ([[index * 2, BAR_UNITS], [index * 2 + 1, BAR_STOCK]] as const).forEach(([i, colour]) => {
        const column = sheet.getColumn(cellRange(i).from).letter;
        const bar = {
          cfvo: [{ type: "num" as const, value: 0 }, { type: "max" as const }],
          color: { argb: colour },
          gradient: true,
          priority: nextCfPriority(sheet),
          showValue: true,
          type: "dataBar" as const,
        };
        try {
          sheet.addConditionalFormatting({ ref: `${column}${firstDataRow}:${column}${lastDataRow}`, rules: [bar] });
        } catch {
          // Data bars are cosmetics — never fail an export over one.
        }
      });
    });
  }

  const totalRow = sheet.getRow(row);
  totalRow.height = 22;
  // Only merge when there is something to merge — ExcelJS rejects a 1x1 "merge".
  if (MGR_LABEL_COLS > 1) sheet.mergeCells(row, 1, row, MGR_LABEL_COLS);
  const totalLabelCell = totalRow.getCell(1);
  totalLabelCell.value = totalLabel;
  totalLabelCell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10 };
  totalLabelCell.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
  totalLabelCell.alignment = { horizontal: "center", vertical: "middle" };
  totalLabelCell.border = { top: rule(ACCENT, "medium") };

  // LIVE FORMULAS over this table's own branch rows and nothing else. The cached result is a
  // courtesy for viewers that never calculate — Excel recalculates on open (fullCalcOnLoad), so the
  // formula is what gets displayed. A correct cached value on a wrong range is exactly how the
  // Closing Matrix lost 18 of 22 region subtotals.
  const productRefs: Array<{ code: string; label: string; units: string; stock: string }> = [];
  products.forEach((product, index) => {
    const totals = productTotals.get(product.key) ?? ZERO;
    const written = [totals.salesUnits, totals.stockUnits].map((value, offset) => {
      const i = index * 2 + offset;
      const letter = sheet.getColumn(cellRange(i).from).letter;
      return put(totalRow, i, (c) => {
        c.value =
          lastDataRow >= firstDataRow
            ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result: value }
            : value;
        c.numFmt = UNITS_DASH_FMT;
        c.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10.5 };
        c.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
        c.alignment = { horizontal: "center", vertical: "middle" };
        c.border = { top: rule(ACCENT, "medium") };
      }).address;
    });
    productRefs.push({ code: product.key, label: product.label, units: written[0], stock: written[1] });
  });

  // Close the total row across the trend column so the band runs the full width of the table.
  const trendTotal = totalRow.getCell(MGR_PAGE_COLS);
  trendTotal.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
  trendTotal.border = { top: rule(ACCENT, "medium") };

  sheet.getRow(row + 1).height = 12;
  return { nextRow: row + 2, productRefs };
}

// ── Tabs 3 + 4: MTD / YTD by Distributor ──────────────────────────────────────

/**
 * Tabs 3 and 4: manager sections, PRODUCTS down the side, DISTRIBUTORS across the top.
 *
 * The axes are the mirror of Tab 2 — there the manager asks "which of my areas sold it", here he
 * asks "which distributor moved it, product by product". Both tabs share this builder because MTD
 * and YTD differ only in period and labels; forking them would leave the workbook visibly
 * inconsistent for no gain.
 *
 * UNITS AND STOCK ONLY. There is no value column anywhere in this workbook — the owner's standing
 * rule, restated 2026-08-12. A figure like "47,967.41" under a units heading is a value that leaked
 * in from an older sheet, not a quantity.
 *
 * The distributor axis is computed ONCE across the whole sheet, so every manager's grid lines up and
 * two sections can be compared by eye.
 */
function buildDistributorSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  rows: WeeklyFactExportRow[],
  index: WeeklyManagerIndex,
  labels: { title: string; subtitle: string; unitsLabel: string; stockLabel: string; note: string },
): void {
  const sheet = workbook.addWorksheet(sheetName);

  // Sheet-wide distributor axis, biggest first. Capped so one stray code cannot stretch the page.
  const unitsByDistributor = new Map<string, number>();
  const nameByDistributor = new Map<string, string>();
  for (const r of rows) {
    unitsByDistributor.set(r.distributorCode, (unitsByDistributor.get(r.distributorCode) ?? 0) + r.salesUnits);
    if (!nameByDistributor.has(r.distributorCode)) nameByDistributor.set(r.distributorCode, r.distributorName || r.distributorCode);
  }
  const axis = [...unitsByDistributor.keys()]
    .sort((a, z) => (unitsByDistributor.get(z) ?? 0) - (unitsByDistributor.get(a) ?? 0) || a.localeCompare(z))
    .slice(0, DIST_AXIS_CAP)
    .map((key) => ({ key, label: nameByDistributor.get(key) ?? key }));

  // No trend column here: Tabs 3/4 carry no week series to draw, and a blank labelled column reads
  // as missing data rather than as an absent feature. The last pair is the row's Total across every
  // distributor — the question "how much of this product did I move altogether".
  //
  // The page is sized to the WIDEST TABLE ACTUALLY RENDERED, not to the sheet-wide distributor list.
  // Each manager shows only the distributors he moved something through, so a company that uses
  // seven distributors can still have no manager using more than five — sizing off the full list left
  // six dead columns that the masthead, the manager band and the cream fill all stretched across,
  // reading as missing data.
  const groups = groupRowsByManager(rows, index).sort(
    (a, z) =>
      a.bucket.sortOrder - z.bucket.sortOrder ||
      managerRegionRank(a) - managerRegionRank(z) ||
      a.bucket.label.localeCompare(z.bucket.label),
  );
  const widestAxis = groups.reduce((widest, group) => {
    const moved = new Set(
      group.rows.filter((r) => r.salesUnits !== 0 || r.stockUnits !== 0).map((r) => r.distributorCode),
    );
    return Math.max(widest, axis.filter((d) => moved.has(d.key)).length);
  }, 0);
  const cols = 1 + Math.max(widestAxis, 1) * 2 + 2; // product label + widest (units, stock) run + Total pair
  const AXIS_LABEL = "Manager × Product × Distributor";

  if (rows.length === 0 || axis.length === 0) {
    premiumMasthead(sheet, Math.max(cols, 4), labels.title, "No data", labels.subtitle, "", AXIS_LABEL);
    sheet.getCell(7, 1).value = "No validated weekly sales in this period.";
    sheet.views = [{ showGridLines: false }];
    return;
  }

  premiumMasthead(sheet, cols, labels.title, labels.unitsLabel, labels.subtitle, "", AXIS_LABEL);
  // See buildManagerSheet: never set outlineProperties — ExcelJS orders sheetPr's children wrongly
  // and Excel then refuses to open the sheet.
  sheet.properties.outlineLevelRow = 2;

  let row = 6;
  for (const group of groups) {
    row = writeManagerBand(sheet, row, group.bucket, cols);
    row = writeProductDistributorBlock(sheet, row, axis, group.rows, `${group.bucket.label} — TOTAL`, labels);
    row += 1;
  }

  sheet.mergeCells(row, 1, row, cols);
  const note = sheet.getCell(row, 1);
  note.value = `${labels.note} Units and stock only — this workbook carries no value column.`;
  note.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9 };
  note.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sheet.getRow(row).height = 30;

  dressPage(sheet, row, cols);
  sheet.views = [{ state: "frozen", xSplit: 1, showGridLines: false }];
}

/** How many distributors the page will carry. Seven exist today; the cap is a runaway guard. */
const DIST_AXIS_CAP = 8;

/** One manager's product x distributor matrix. Rows are products; columns are distributor pairs. */
function writeProductDistributorBlock(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  sheetAxis: Array<{ key: string; label: string }>,
  rows: WeeklyFactExportRow[],
  totalLabel: string,
  labels: { unitsLabel: string; stockLabel: string },
): number {
  const products = rollup(rows, (r) => r.productCode, (r) => r.productName || r.productCode).sort(
    (a, z) => z.salesUnits - a.salesUnits || a.label.localeCompare(z.label),
  );

  const cell = new Map<string, SummaryTotals>();
  for (const r of rows) {
    const key = `${r.productCode}||${r.distributorCode}`;
    const current = cell.get(key) ?? { ...ZERO };
    addInto(current, r);
    cell.set(key, current);
  }

  // ONLY the distributors this manager actually moved something through — sales, stock, or both.
  // Owner's rule, 2026-08-12. A column of dashes under a manager who never sells through that
  // distributor is noise, and on the YTD sheet it was most of the grid: seven distributors exist
  // company-wide but a single manager typically uses two or three.
  //
  // The axis is therefore PER MANAGER, so tables differ in width. The page frame stays the
  // sheet-wide width (pageCols) so the masthead, footnote and border still line up.
  const moved = new Set<string>();
  for (const r of rows) {
    if (r.salesUnits !== 0 || r.stockUnits !== 0) moved.add(r.distributorCode);
  }
  const axis = sheetAxis.filter((d) => moved.has(d.key));
  if (axis.length === 0) return startRow;
  const cols = 1 + axis.length * 2 + 2;

  let row = startRow;
  const header = sheet.getRow(row);
  const subHeader = sheet.getRow(row + 1);
  header.outlineLevel = 1;
  subHeader.outlineLevel = 1;

  sheet.mergeCells(row, 1, row + 1, 1);
  const productHead = header.getCell(1);
  productHead.value = "PRODUCT";
  productHead.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 9 };
  productHead.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
  productHead.alignment = { horizontal: "center", vertical: "middle" };
  productHead.border = { bottom: rule(INK_SOFT) };
  sheet.getColumn(1).width = 30;

  axis.forEach((dist, i) => {
    const unitsCol = 2 + i * 2;
    sheet.mergeCells(row, unitsCol, row, unitsCol + 1);
    const head = header.getCell(unitsCol);
    head.value = dist.label;
    head.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 10.5 };
    head.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
    head.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    head.border = { left: rule(i > 0 ? HAIRLINE : INK_SOFT) };

    ([[labels.unitsLabel, unitsCol], [labels.stockLabel, unitsCol + 1]] as const).forEach(([text, c], k) => {
      const sub = subHeader.getCell(c);
      sub.value = text.toUpperCase();
      sub.font = { bold: true, color: { argb: MUTED_WARM }, name: "Calibri", size: 7.5 };
      sub.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
      sub.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      sub.border = { bottom: rule(INK_SOFT), ...(k === 0 ? { left: rule(i > 0 ? HAIRLINE : INK_SOFT) } : {}) };
      sheet.getColumn(c).width = 13;
    });
  });

  // The Total group closes the grid on the right. Given its own accent rule so the eye reads it as a
  // summary of the distributors beside it, not as one more distributor.
  const totalUnitsCol = cols - 1;
  sheet.mergeCells(row, totalUnitsCol, row, cols);
  const totalHead = header.getCell(totalUnitsCol);
  totalHead.value = "Total";
  totalHead.font = { bold: true, color: { argb: CLAY }, name: "Calibri", size: 10.5 };
  totalHead.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
  totalHead.alignment = { horizontal: "center", vertical: "middle" };
  totalHead.border = { left: rule(ACCENT, "medium") };
  ([[labels.unitsLabel, totalUnitsCol], [labels.stockLabel, cols]] as const).forEach(([text, c], k) => {
    const sub = subHeader.getCell(c);
    sub.value = text.toUpperCase();
    sub.font = { bold: true, color: { argb: CLAY }, name: "Calibri", size: 7.5 };
    sub.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
    sub.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    sub.border = { bottom: rule(INK_SOFT), ...(k === 0 ? { left: rule(ACCENT, "medium") } : {}) };
    sheet.getColumn(c).width = 14;
  });

  header.height = 26;
  subHeader.height = 16;
  row += 2;

  const firstDataRow = row;
  products.forEach((product, index) => {
    const excelRow = sheet.getRow(row);
    const tint = index % 2 === 1 ? CREAM_ALT : CREAM;
    const label = excelRow.getCell(1);
    label.value = product.label;
    label.font = { color: { argb: INK_SOFT }, name: "Calibri", size: 10.5 };
    label.alignment = { horizontal: "center", vertical: "middle" };
    label.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };

    axis.forEach((dist, i) => {
      const totals = cell.get(`${product.key}||${dist.key}`) ?? ZERO;
      [totals.salesUnits, totals.stockUnits].forEach((value, offset) => {
        const c = excelRow.getCell(2 + i * 2 + offset);
        c.value = value;
        c.numFmt = UNITS_DASH_FMT;
        c.font = { color: { argb: value === 0 ? MUTED_WARM : INK_SOFT }, name: "Calibri", size: 10.5 };
        c.alignment = { horizontal: "center", vertical: "middle" };
        c.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
        if (offset === 0) c.border = { left: rule(i > 0 ? HAIRLINE : INK_SOFT) };
      });
    });

    // This product's total across every distributor. A LIVE formula over the row's own cells, which
    // are non-contiguous (units sit in every other column), so it is an explicit cell list.
    ([[totalUnitsCol, 0], [cols, 1]] as const).forEach(([target, offset]) => {
      const refs = axis.map((_, i) => sheet.getRow(excelRow.number).getCell(2 + i * 2 + offset).address);
      const cached = axis.reduce((sum, dist) => {
        const t = cell.get(`${product.key}||${dist.key}`) ?? ZERO;
        return sum + (offset === 0 ? t.salesUnits : t.stockUnits);
      }, 0);
      const c = excelRow.getCell(target);
      c.value = refs.length > 0 ? { formula: `SUM(${refs.join(",")})`, result: cached } : cached;
      c.numFmt = UNITS_DASH_FMT;
      c.font = { bold: true, color: { argb: cached === 0 ? MUTED_WARM : CLAY }, name: "Calibri", size: 10.5 };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
      if (offset === 0) c.border = { left: rule(ACCENT, "medium") };
    });

    for (let c = 1; c <= cols; c += 1) {
      const gridCell = excelRow.getCell(c);
      gridCell.border = { ...(gridCell.border ?? {}), bottom: rule(HAIRLINE) };
    }
    excelRow.height = 17;
    excelRow.outlineLevel = 1;
    row += 1;
  });
  const lastDataRow = row - 1;

  if (lastDataRow - firstDataRow >= 2) {
    axis.forEach((_, i) => {
      ([[2 + i * 2, BAR_UNITS], [3 + i * 2, BAR_STOCK]] as const).forEach(([c, colour]) => {
        const column = sheet.getColumn(c).letter;
        const bar = {
          cfvo: [{ type: "num" as const, value: 0 }, { type: "max" as const }],
          color: { argb: colour },
          gradient: true,
          priority: nextCfPriority(sheet),
          showValue: true,
          type: "dataBar" as const,
        };
        try {
          sheet.addConditionalFormatting({ ref: `${column}${firstDataRow}:${column}${lastDataRow}`, rules: [bar] });
        } catch {
          // Data bars are cosmetics — never fail an export over one.
        }
      });
    });
  }

  const totalRow = sheet.getRow(row);
  totalRow.height = 22;
  const totalLabelCell = totalRow.getCell(1);
  totalLabelCell.value = totalLabel;
  totalLabelCell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10 };
  totalLabelCell.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
  totalLabelCell.alignment = { horizontal: "center", vertical: "middle" };
  totalLabelCell.border = { top: rule(ACCENT, "medium") };

  // Live SUMs over this manager's own product rows and nothing else.
  axis.forEach((dist, i) => {
    [0, 1].forEach((offset) => {
      const c = 2 + i * 2 + offset;
      const letter = sheet.getColumn(c).letter;
      const cached = rows
        .filter((r) => r.distributorCode === dist.key)
        .reduce((sum, r) => sum + (offset === 0 ? r.salesUnits : r.stockUnits), 0);
      const target = totalRow.getCell(c);
      target.value =
        lastDataRow >= firstDataRow
          ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result: cached }
          : cached;
      target.numFmt = UNITS_DASH_FMT;
      target.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10.5 };
      target.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
      target.alignment = { horizontal: "center", vertical: "middle" };
      target.border = { top: rule(ACCENT, "medium") };
    });
  });
  // Grand total for the manager, summing the Total COLUMN above rather than the row of distributor
  // totals. Both give the same number; taking the column keeps every cell on this row the same
  // shape, so a reader can check any one of them the same way.
  ([totalUnitsCol, cols] as const).forEach((c, offset) => {
    const letter = sheet.getColumn(c).letter;
    const cached = rows.reduce((sum, r) => sum + (offset === 0 ? r.salesUnits : r.stockUnits), 0);
    const target = totalRow.getCell(c);
    target.value =
      lastDataRow >= firstDataRow
        ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result: cached }
        : cached;
    target.numFmt = UNITS_DASH_FMT;
    target.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 11 };
    target.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
    target.alignment = { horizontal: "center", vertical: "middle" };
    target.border = { top: rule(ACCENT, "medium"), ...(offset === 0 ? { left: rule(ACCENT, "medium") } : {}) };
  });

  sheet.getRow(row + 1).height = 12;
  return row + 2;
}

// ── Tab 5: Critical low-sales branches with stock ─────────────────────────────

function buildLowSalesSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: WeeklyFactExportRow[],
  index: WeeklyManagerIndex,
  lineLabel: string,
  generatedAt: string,
  /** area_code -> area name. Owner rule: show the name, never the code. */
  areaNames: Map<string, string>,
): void {
  const sheet = workbook.addWorksheet(name);
  const LOW_COLS = 6; // Distributor | Branch | Area | Product | Units sold | Stock on hand

  // Flagged at BRANCH x PRODUCT, not branch. A branch that sold 3 Saginko and 200 Lacto is not a
  // problem branch, but its 3-unit Saginko sitting on 400 in stock still is — and the whole point of
  // this rebuild is that a figure must say WHICH product it is about. Aggregating products away also
  // hid the cases worth acting on behind a healthy branch total.
  const byCell = new Map<
    string,
    {
      manager: WeeklyManagerBucket;
      distributorName: string;
      branchName: string;
      areaName: string;
      productName: string;
      regionCode: string;
    } & SummaryTotals
  >();
  for (const row of rows) {
    const manager = resolveWeeklyManager(index, row.line, row.regionCode);
    const key = `${manager.key}||${row.distributorCode}||${row.branchCode || row.branchName}||${row.productCode}`;
    const areaCode = (row.areaCode ?? "").trim().toUpperCase();
    const existing =
      byCell.get(key) ?? {
        manager,
        distributorName: row.distributorName || row.distributorCode,
        branchName: row.branchName || row.branchCode,
        // Short form here: the full Tab 2 wording would not fit a narrow column, and on this tab the
        // point is simply "no area owns this branch" — it is a key account, chain or wholesale depot.
        areaName: areaCode ? (areaNames.get(areaCode) ?? areaCode) : "Not area-mapped",
        productName: row.productName || row.productCode,
        regionCode: row.regionCode,
        ...ZERO,
      };
    addInto(existing, row);
    byCell.set(key, existing);
  }

  const matching = [...byCell.values()].filter(
    (entry) =>
      isActionableLowSalesBucket(entry.manager.kind) &&
      isLowSalesWithStock(entry.salesUnits, entry.stockUnits),
  );
  const flagged = matching.filter((entry) => entry.stockUnits > LOW_SALES_STOCK_FLOOR);
  // Never silently drop a row. What the floor held back is counted and stated on the sheet.
  const belowFloor = matching.length - flagged.length;
  const belowFloorStock = matching
    .filter((entry) => entry.stockUnits <= LOW_SALES_STOCK_FLOOR)
    .reduce((sum, entry) => sum + entry.stockUnits, 0);

  premiumMasthead(
    sheet,
    LOW_COLS,
    `${lineLabel} — Critical: Low Sales With Stock On Hand`,
    `${flagged.length} product${flagged.length === 1 ? "" : "s"} flagged`,
    `Cycle month ${currentCairoCycleMonth()} · 0-5 units sold, holding more than ${LOW_SALES_STOCK_FLOOR} units`,
    generatedAt,
    "Manager × Branch × Product",
  );
  sheet.properties.outlineLevelRow = 2;

  if (flagged.length === 0) {
    sheet.getCell(7, 1).value = "Nothing is holding stock with 0-5 units sold this month.";
    sheet.views = [{ showGridLines: false }];
    return;
  }

  const sections = new Map<string, { manager: WeeklyManagerBucket; entries: typeof flagged }>();
  for (const entry of flagged) {
    const section = sections.get(entry.manager.key);
    if (section) section.entries.push(entry);
    else sections.set(entry.manager.key, { manager: entry.manager, entries: [entry] });
  }

  let row = 6;
  // Same section order as Tabs 2-4: kind first, then Monthly Closing geography. compareManagerBuckets
  // alone sorts alphabetically, which would put this tab's managers in a different order from every
  // other tab in the same workbook.
  const sectionRank = (s: { manager: WeeklyManagerBucket; entries: typeof flagged }) => {
    let best = Number.POSITIVE_INFINITY;
    for (const e of s.entries) best = Math.min(best, monthlyClosingRegionRank(normalizeRegion(e.regionCode)));
    return Number.isFinite(best) ? best : Number.MAX_SAFE_INTEGER;
  };
  for (const section of [...sections.values()].sort(
    (a, z) =>
      a.manager.sortOrder - z.manager.sortOrder ||
      sectionRank(a) - sectionRank(z) ||
      compareManagerBuckets(a.manager, z.manager),
  )) {
    // Worst first: fewest units sold, then most stock sitting there.
    const entries = section.entries.sort(
      (a, z) =>
        a.salesUnits - z.salesUnits ||
        z.stockUnits - a.stockUnits ||
        a.branchName.localeCompare(z.branchName) ||
        a.productName.localeCompare(z.productName),
    );

    row = writeManagerBand(sheet, row, section.manager, LOW_COLS);

    const header = sheet.getRow(row);
    header.outlineLevel = 1;
    (
      [
        ["DISTRIBUTOR", 20],
        ["BRANCH", 30],
        ["AREA", 22],
        ["PRODUCT", 26],
        ["UNITS SOLD", 13],
        ["STOCK ON HAND", 15],
      ] as const
    ).forEach(([label, width], i) => {
      const cell = header.getCell(i + 1);
      cell.value = label;
      cell.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 9 };
      cell.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = { bottom: rule(INK_SOFT), ...(i >= 4 ? { left: rule(HAIRLINE) } : {}) };
      sheet.getColumn(i + 1).width = width;
    });
    header.height = 24;
    row += 1;

    const firstDataRow = row;
    entries.forEach((entry, i) => {
      const excelRow = sheet.getRow(row);
      const tint = i % 2 === 1 ? CREAM_ALT : CREAM;
      (
        [
          entry.distributorName,
          entry.branchName,
          entry.areaName,
          entry.productName,
          entry.salesUnits,
          entry.stockUnits,
        ] as const
      ).forEach((value, c) => {
        const cell = excelRow.getCell(c + 1);
        cell.value = value;
        if (c >= 4) cell.numFmt = UNITS_DASH_FMT;
        const unmapped = c === 2 && entry.areaName === "Not area-mapped";
        cell.font = {
          color: { argb: c === 5 ? CLAY : unmapped ? MUTED_WARM : INK_SOFT },
          bold: c === 5,
          italic: unmapped,
          name: "Calibri",
          size: unmapped ? 9.5 : 10.5,
        };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = { fgColor: { argb: tint }, pattern: "solid", type: "pattern" };
        cell.border = { bottom: rule(HAIRLINE), ...(c >= 4 ? { left: rule(HAIRLINE) } : {}) };
      });
      excelRow.height = 17;
      excelRow.outlineLevel = 1;
      row += 1;
    });
    const lastDataRow = row - 1;

    // The bar goes on STOCK — the bigger the bar, the more is sitting still.
    if (lastDataRow - firstDataRow >= 2) {
      const bar = {
        cfvo: [{ type: "num" as const, value: 0 }, { type: "max" as const }],
        color: { argb: BAR_STOCK },
        gradient: true,
        priority: nextCfPriority(sheet),
        showValue: true,
        type: "dataBar" as const,
      };
      try {
        sheet.addConditionalFormatting({ ref: `F${firstDataRow}:F${lastDataRow}`, rules: [bar] });
      } catch {
        // Data bars are cosmetics — never fail an export over one.
      }
    }

    const totalRow = sheet.getRow(row);
    totalRow.height = 22;
    sheet.mergeCells(row, 1, row, 4);
    // Both counts, because they answer different questions: how many PLACES to visit, and how many
    // product lines are stuck once you get there. One flagged branch with twelve stuck products is a
    // very different errand from twelve branches with one each.
    const branchCount = new Set(entries.map((e) => `${e.distributorName}||${e.branchName}`)).size;
    const label = totalRow.getCell(1);
    label.value =
      `${section.manager.label} — ${branchCount} branch${branchCount === 1 ? "" : "es"}` +
      ` · ${entries.length} product${entries.length === 1 ? "" : "s"} sitting`;
    label.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10 };
    label.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
    label.alignment = { horizontal: "center", vertical: "middle" };
    label.border = { top: rule(ACCENT, "medium") };
    ([5, 6] as const).forEach((c, offset) => {
      const letter = sheet.getColumn(c).letter;
      const cached = entries.reduce((sum, e) => sum + (offset === 0 ? e.salesUnits : e.stockUnits), 0);
      const cell = totalRow.getCell(c);
      cell.value =
        lastDataRow >= firstDataRow
          ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result: cached }
          : cached;
      cell.numFmt = UNITS_DASH_FMT;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 10.5 };
      cell.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = { top: rule(ACCENT, "medium"), left: rule(HAIRLINE) };
    });
    row += 2;
  }

  sheet.mergeCells(row, 1, row, LOW_COLS);
  const note = sheet.getCell(row, 1);
  note.value =
    `${flagged.length} product${flagged.length === 1 ? "" : "s"} across ${sections.size} manager${sections.size === 1 ? "" : "s"} ` +
    `are holding more than ${LOW_SALES_STOCK_FLOOR} units with 0-5 sold. Flagged at branch × PRODUCT, ` +
    "so a slow product is not hidden behind a healthy branch total. " +
    (belowFloor > 0
      ? `A further ${belowFloor} met the rule but hold ${LOW_SALES_STOCK_FLOOR} units or fewer ` +
        `(${Math.round(belowFloorStock).toLocaleString()} units in total) and are held back as too small to chase — they are not lost, ` +
        "just below the line. "
      : "") +
    "Sorted worst-first: fewest units sold, then most stock held. Head Office is excluded here (no " +
    "field manager to action it) but still appears in the other tabs. Distributors that do not " +
    "report stock at all can never appear. " +
    ATTRIBUTION_CAVEAT;
  note.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9 };
  note.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sheet.getRow(row).height = 34;

  dressPage(sheet, row, LOW_COLS);
  sheet.views = [{ state: "frozen", xSplit: 2, showGridLines: false }];
}

// ── Tab 6: Month vs Target ────────────────────────────────────────────────────
//
// "The sales in the month I am uploading, against that month's whole target — per area and per
// region." Owner's request, 2026-08-16.
//
// Three things make this tab honest rather than merely plausible:
//
//   1. UNITS, never value. Targets carry both units and value, and the value side is tempting —
//      achievement is a value ratio everywhere else in this system. But a weekly sales VALUE is the
//      distributor's own money re-valued at current master price, while a target VALUE is built off
//      factory price, so the ratio would be two different currencies over one another. The units are
//      the same physical thing on both sides. It also keeps the workbook's standing rule intact:
//      there is no value column anywhere in it.
//
//   2. The target is the WHOLE month's; the sales are whatever weeks have been uploaded so far. That
//      is exactly what he asked for, and it means a mid-month sheet SHOULD read below 100%. The tab
//      says so in its own subtitle rather than leaving the reader to infer it.
//
//   3. A region here is the region the AREA belongs to, not the region the distributor branch was
//      mapped to. Those two vocabularies agree almost always, but where they disagree the area rows
//      would not add up to the region row above them — and a vs-target sheet whose subtotals do not
//      reconcile is worse than no sheet. Only rows with no area at all fall back to the branch's own
//      weekly region.

/**
 * One (line, area) field target for the month, in units.
 *
 * The line arrives as its OFFICIAL NAME ("CNS", "Pedia", "Anti Infective"), already resolved from
 * the engine's line_code by the caller. That keeps this module free of the targets domain — and of
 * the database client it carries — so the whole tab stays unit-testable without a connection.
 */
export type MonthTargetInput = {
  lineLabel: string;
  areaCode: string;
  targetUnits: number;
};

export type VsTargetRow = {
  label: string;
  salesUnits: number;
  targetUnits: number;
  /** null when there is no target to divide by. NEVER 0, which a reader takes for a collapse. */
  achievement: number | null;
  /** The not-area-mapped bucket: real sales that no single area owns, so no target can exist. */
  unmapped: boolean;
};

export type VsTargetRegion = VsTargetRow & { regionCode: string; areas: VsTargetRow[] };

export type VsTargetSection = VsTargetRow & {
  regions: VsTargetRegion[];
  /** false when NO target was uploaded for this line this month — reported as such, never as 0%. */
  hasTarget: boolean;
};

/** Sales that carry neither an area nor a region. Rare, but it must still land somewhere named. */
const UNKNOWN_REGION_LABEL = "Region not mapped";

/**
 * The short form of NO_AREA_LABEL, for the same reason Tab 5 uses one: this tab's label column is
 * 40 characters and the full wording is 47, so it would be CLIPPED — and the owner's standing rule
 * is that no text in this system is ever truncated or wrapped. The full explanation of what sits in
 * this row is in the footnote, where it has room.
 */
const VS_TARGET_NO_AREA_LABEL = "Not area-mapped";

const achievementOf = (salesUnits: number, targetUnits: number): number | null =>
  targetUnits > 0 ? salesUnits / targetUnits : null;

/**
 * Fold the month's sales and the month's targets into line → region → area.
 *
 * Pure, and deliberately total: every unit on either side reaches a row.
 *   - an area with a target and no sales still appears (that is the row worth acting on);
 *   - an area with sales and no target still appears, with a dash rather than a 0% ;
 *   - sales with no area collect in one named row inside their region, never dropped;
 *   - a line with no uploaded target keeps its whole grid and is flagged, never silently zeroed.
 */
export function buildVsTargetModel(
  monthRows: WeeklyFactExportRow[],
  targets: MonthTargetInput[],
  /** area_code (upper) -> its name and the region that carries its target. */
  areaIndex: Map<string, { areaName: string; regionCode: string }>,
  /** Official line names that HAVE a target this month — how "no target" is told from "target 0". */
  targetedLines: string[],
  /** region_code -> region name. Owner's rule: never print a code. */
  regionNames: Map<string, string>,
): VsTargetSection[] {
  type Cell = { salesUnits: number; targetUnits: number };
  // line -> region -> areaCode -> cell. An empty areaCode key is the not-area-mapped bucket.
  const tree = new Map<string, Map<string, Map<string, Cell>>>();
  // Preserve each label as written on the data rather than as normalised for lookup.
  const lineLabels = new Map<string, string>();
  const rowRegionNames = new Map<string, string>();

  const cellOf = (lineKey: string, region: string, areaCode: string): Cell => {
    let regions = tree.get(lineKey);
    if (!regions) tree.set(lineKey, (regions = new Map()));
    let areas = regions.get(region);
    if (!areas) regions.set(region, (areas = new Map()));
    let cell = areas.get(areaCode);
    if (!cell) areas.set(areaCode, (cell = { salesUnits: 0, targetUnits: 0 }));
    return cell;
  };

  for (const row of monthRows) {
    const label = normalizeLine(row.line);
    const lineKey = label.toLowerCase();
    if (!lineLabels.has(lineKey)) lineLabels.set(lineKey, label || "Unassigned line");
    const areaCode = (row.areaCode ?? "").trim().toUpperCase();
    const mapped = areaCode ? areaIndex.get(areaCode) : undefined;
    // The area's own region wins, so the area rows below a region row always sum to it. The
    // branch's weekly region is the fallback only where the area map cannot answer.
    const region = normalizeRegion(mapped?.regionCode) || normalizeRegion(row.regionCode) || "";
    if (region && !rowRegionNames.has(region)) rowRegionNames.set(region, (row.regionName ?? "").trim());
    cellOf(lineKey, region, areaCode).salesUnits += row.salesUnits;
  }

  for (const target of targets) {
    const label = normalizeLine(target.lineLabel);
    const lineKey = label.toLowerCase();
    if (!lineKey) continue;
    if (!lineLabels.has(lineKey)) lineLabels.set(lineKey, label);
    const areaCode = target.areaCode.trim().toUpperCase();
    if (!areaCode) continue;
    const region = normalizeRegion(areaIndex.get(areaCode)?.regionCode) || "";
    cellOf(lineKey, region, areaCode).targetUnits += target.targetUnits;
  }

  const targeted = new Set(targetedLines.map((line) => normalizeLine(line).toLowerCase()).filter(Boolean));
  const nameOfRegion = (code: string) =>
    code ? regionNames.get(code) || rowRegionNames.get(code) || code : UNKNOWN_REGION_LABEL;

  const sections: VsTargetSection[] = [];
  for (const [lineKey, regions] of tree) {
    const regionRows: VsTargetRegion[] = [];
    for (const [regionCode, areas] of regions) {
      const areaRows: VsTargetRow[] = [];
      for (const [areaCode, cell] of areas) {
        // Nothing on either side means the key only exists because a filter emptied it — skip, or
        // every line would print all 42 areas at zero.
        if (cell.salesUnits === 0 && cell.targetUnits === 0) continue;
        areaRows.push({
          label: areaCode ? (areaIndex.get(areaCode)?.areaName || areaCode) : VS_TARGET_NO_AREA_LABEL,
          salesUnits: cell.salesUnits,
          targetUnits: cell.targetUnits,
          achievement: achievementOf(cell.salesUnits, cell.targetUnits),
          unmapped: areaCode === "",
        });
      }
      if (areaRows.length === 0) continue;
      // The not-area-mapped residue always closes the region: it is context for the rows above it,
      // not a peer of them.
      areaRows.sort(
        (a, z) =>
          Number(a.unmapped) - Number(z.unmapped) ||
          z.salesUnits - a.salesUnits ||
          z.targetUnits - a.targetUnits ||
          a.label.localeCompare(z.label),
      );
      const salesUnits = areaRows.reduce((sum, area) => sum + area.salesUnits, 0);
      const targetUnits = areaRows.reduce((sum, area) => sum + area.targetUnits, 0);
      regionRows.push({
        regionCode,
        label: nameOfRegion(regionCode),
        salesUnits,
        targetUnits,
        achievement: achievementOf(salesUnits, targetUnits),
        unmapped: false,
        areas: areaRows,
      });
    }
    if (regionRows.length === 0) continue;
    // Monthly Closing sequence, the order he reads every other report in.
    regionRows.sort(
      (a, z) => monthlyClosingRegionRank(a.regionCode) - monthlyClosingRegionRank(z.regionCode) || a.label.localeCompare(z.label),
    );
    const salesUnits = regionRows.reduce((sum, region) => sum + region.salesUnits, 0);
    const targetUnits = regionRows.reduce((sum, region) => sum + region.targetUnits, 0);
    sections.push({
      label: lineLabels.get(lineKey) ?? lineKey,
      hasTarget: targeted.has(lineKey),
      salesUnits,
      targetUnits,
      achievement: achievementOf(salesUnits, targetUnits),
      unmapped: false,
      regions: regionRows,
    });
  }

  // Lines that are actually being measured come first; an untargeted line is context, not the point.
  return sections.sort(
    (a, z) => Number(z.hasTarget) - Number(a.hasTarget) || z.salesUnits - a.salesUnits || a.label.localeCompare(z.label),
  );
}

/** Region label | Month sales | Month target | Achievement | Gap — A..E. */
const VS_TARGET_COLS = 5;

function buildVsTargetSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  sections: VsTargetSection[],
  lineLabel: string,
  /** The month being measured, as YYYY-MM. */
  periodLabel: string,
  generatedAt: string,
  /** Set when the viewer's distributor/product filters narrow the sales but cannot narrow targets. */
  filterCaveat: string,
): void {
  const sheet = workbook.addWorksheet(name);

  const totalSales = sections.reduce((sum, section) => sum + section.salesUnits, 0);
  const totalTarget = sections.reduce((sum, section) => sum + section.targetUnits, 0);
  const measured = sections.filter((section) => section.hasTarget);
  const unmeasured = sections.filter((section) => !section.hasTarget);
  const overall = achievementOf(
    measured.reduce((sum, section) => sum + section.salesUnits, 0),
    measured.reduce((sum, section) => sum + section.targetUnits, 0),
  );

  premiumMasthead(
    sheet,
    VS_TARGET_COLS,
    `${lineLabel} — Month vs Target`,
    overall == null ? "No target uploaded" : `${Math.round(overall * 100)}% of the month's target`,
    `Uploaded sales for ${periodLabel} against the FULL month target · units only`,
    generatedAt,
    "Line × Region × Area",
  );
  // Areas group under their region, so he can collapse to a region-only view and back. Never set
  // outlineProperties alongside it — ExcelJS emits sheetPr's children out of order and Excel then
  // offers to repair the file (see buildManagerSheet).
  sheet.properties.outlineLevelRow = 2;

  if (sections.length === 0) {
    sheet.getCell(7, 1).value = `No validated weekly sales and no uploaded target for ${periodLabel}.`;
    sheet.views = [{ showGridLines: false }];
    return;
  }

  let row = 6;
  for (const section of sections) {
    // The section anchor, in the same grammar as the manager bands on Tabs 2-5: one ink line naming
    // the block, its caption quietly on cream beneath.
    sheet.mergeCells(row, 1, row, VS_TARGET_COLS);
    const title = sheet.getCell(row, 1);
    title.value = section.label;
    title.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri Light", size: 14 };
    title.fill = { fgColor: { argb: INK }, pattern: "solid", type: "pattern" };
    title.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(row).height = 24;
    row += 1;

    sheet.mergeCells(row, 1, row, VS_TARGET_COLS);
    const caption = sheet.getCell(row, 1);
    caption.value = section.hasTarget
      ? `Target for ${periodLabel}: ${Math.round(section.targetUnits).toLocaleString()} units` +
        `   ·   ${section.regions.length} region${section.regions.length === 1 ? "" : "s"}`
      : `No target uploaded for ${periodLabel} — sales are shown, achievement cannot be calculated`;
    caption.font = {
      color: { argb: section.hasTarget ? MUTED_WARM : CLAY },
      italic: !section.hasTarget,
      name: "Calibri",
      size: 8.5,
    };
    caption.fill = { fgColor: { argb: CREAM }, pattern: "solid", type: "pattern" };
    caption.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(row).height = 15;
    row += 1;

    const header = sheet.getRow(row);
    (
      [
        ["REGION  /  AREA", 40],
        ["MONTH SALES (UNITS)", 18],
        ["MONTH TARGET (UNITS)", 19],
        ["ACHIEVEMENT", 15],
        ["GAP TO TARGET", 16],
      ] as const
    ).forEach(([label, width], i) => {
      const cell = header.getCell(i + 1);
      cell.value = label;
      cell.font = { bold: true, color: { argb: INK }, name: "Calibri", size: 9 };
      cell.fill = { fgColor: { argb: BONE }, pattern: "solid", type: "pattern" };
      cell.alignment = { horizontal: i === 0 ? "left" : "center", indent: i === 0 ? 1 : 0, vertical: "middle", wrapText: true };
      cell.border = { bottom: rule(INK_SOFT), ...(i >= 1 ? { left: rule(HAIRLINE) } : {}) };
      sheet.getColumn(i + 1).width = width;
    });
    header.height = 24;
    row += 1;

    const achievementRows: number[] = [];
    const writeRow = (entry: VsTargetRow, kind: "region" | "area") => {
      const excelRow = sheet.getRow(row);
      const isRegion = kind === "region";
      const ground = isRegion ? BONE : CREAM;

      const label = excelRow.getCell(1);
      label.value = isRegion ? entry.label : `      ${entry.label}`;
      label.font = {
        bold: isRegion,
        color: { argb: isRegion ? INK : entry.unmapped ? MUTED_WARM : INK_SOFT },
        italic: entry.unmapped,
        name: "Calibri",
        size: isRegion ? 11 : entry.unmapped ? 9.5 : 10.5,
      };
      label.alignment = { horizontal: "left", indent: 1, vertical: "middle" };

      const sales = excelRow.getCell(2);
      sales.value = entry.salesUnits;
      sales.numFmt = UNITS_DASH_FMT;
      sales.font = { bold: isRegion, color: { argb: isRegion ? INK : INK_SOFT }, name: "Calibri", size: 10.5 };

      const target = excelRow.getCell(3);
      target.value = entry.targetUnits;
      target.numFmt = UNITS_DASH_FMT;
      target.font = { bold: isRegion, color: { argb: isRegion ? INK : INK_SOFT }, name: "Calibri", size: 10.5 };

      // Achievement and gap are FORMULAS, not cached arithmetic. Excel recalculates every workbook
      // this repo writes on open, so a hand-computed value would be replaced anyway — and both guard
      // the zero-target case in the sheet itself, so an area with no target reads as a dash instead
      // of as 0% (a collapse) or as a surplus equal to its whole sales figure.
      const achievement = excelRow.getCell(4);
      achievement.value = { formula: `IF(C${row}=0,"–",B${row}/C${row})`, result: entry.achievement ?? "–" };
      achievement.numFmt = '0.0%;-0.0%;"–"';
      achievement.font = {
        bold: true,
        color: {
          argb:
            entry.achievement == null ? MUTED_WARM : entry.achievement >= 1 ? GOOD : entry.achievement < 0.8 ? CLAY : INK_SOFT,
        },
        name: "Calibri",
        size: 10.5,
      };

      const gap = excelRow.getCell(5);
      gap.value = {
        formula: `IF(C${row}=0,"–",B${row}-C${row})`,
        result: entry.targetUnits > 0 ? entry.salesUnits - entry.targetUnits : "–",
      };
      gap.numFmt = UNITS_DASH_FMT;
      gap.font = {
        color: { argb: entry.targetUnits === 0 ? MUTED_WARM : entry.salesUnits >= entry.targetUnits ? GOOD : CLAY },
        name: "Calibri",
        size: 10.5,
      };

      for (let c = 1; c <= VS_TARGET_COLS; c += 1) {
        const cell = excelRow.getCell(c);
        if (c >= 2) cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = { fgColor: { argb: ground }, pattern: "solid", type: "pattern" };
        cell.border = {
          bottom: rule(HAIRLINE),
          ...(c >= 2 ? { left: rule(HAIRLINE) } : {}),
          ...(isRegion ? { top: rule(INK_SOFT) } : {}),
        };
      }
      excelRow.height = isRegion ? 20 : 17;
      if (!isRegion) excelRow.outlineLevel = 1;
      achievementRows.push(row);
      row += 1;
    };

    for (const region of section.regions) {
      writeRow(region, "region");
      for (const area of region.areas) writeRow(area, "area");
    }

    // One bar per section over its achievement column, capped at 100% so a 300% outlier does not
    // flatten every other area to a sliver. Cosmetic only — never fail an export over it.
    if (section.hasTarget && achievementRows.length >= 2) {
      const first = achievementRows[0];
      const last = achievementRows[achievementRows.length - 1];
      // Built as a variable, not inlined: ExcelJS's DataBarRuleType omits `color`, which Excel and
      // the library both honour, so an inline literal trips excess-property checking. Tab 5's bar is
      // written the same way for the same reason.
      const bar = {
        cfvo: [{ type: "num" as const, value: 0 }, { type: "num" as const, value: 1 }],
        color: { argb: BAR_UNITS },
        gradient: true,
        priority: nextCfPriority(sheet),
        showValue: true,
        type: "dataBar" as const,
      };
      try {
        sheet.addConditionalFormatting({ ref: `D${first}:D${last}`, rules: [bar] });
      } catch {
        // Data bars are decoration; a workbook that fails to build is not.
      }
    }

    const totalRow = sheet.getRow(row);
    totalRow.height = 22;
    const totalLabel = totalRow.getCell(1);
    totalLabel.value = `${section.label} — TOTAL`;
    totalLabel.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    totalRow.getCell(2).value = section.salesUnits;
    totalRow.getCell(3).value = section.targetUnits;
    totalRow.getCell(4).value = { formula: `IF(C${row}=0,"–",B${row}/C${row})`, result: section.achievement ?? "–" };
    totalRow.getCell(5).value = {
      formula: `IF(C${row}=0,"–",B${row}-C${row})`,
      result: section.targetUnits > 0 ? section.salesUnits - section.targetUnits : "–",
    };
    for (let c = 1; c <= VS_TARGET_COLS; c += 1) {
      const cell = totalRow.getCell(c);
      if (c === 4) cell.numFmt = '0.0%;-0.0%;"–"';
      else if (c >= 2) cell.numFmt = UNITS_DASH_FMT;
      if (c >= 2) cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: c === 1 ? 10 : 10.5 };
      cell.fill = { fgColor: { argb: CLAY }, pattern: "solid", type: "pattern" };
      cell.border = { top: rule(ACCENT, "medium"), ...(c >= 2 ? { left: rule(HAIRLINE) } : {}) };
    }
    row += 2;
  }

  sheet.mergeCells(row, 1, row, VS_TARGET_COLS);
  const note = sheet.getCell(row, 1);
  note.value =
    `Sales are the units uploaded so far for ${periodLabel}, de-cumulated so each week counts once. ` +
    "The target is the WHOLE month's, so mid-month this sheet is expected to read under 100% — it " +
    "answers \"how much of the month is already in\", not \"did we hit it\". " +
    "A region row is the sum of the area rows beneath it, and an area is counted under the region " +
    "that carries its target, so the two always reconcile. " +
    `Total across every line: ${Math.round(totalSales).toLocaleString()} units sold against ` +
    `${Math.round(totalTarget).toLocaleString()} units of target. ` +
    (unmeasured.length > 0
      ? `${unmeasured.map((section) => section.label).join(", ")} ` +
        `${unmeasured.length === 1 ? "has" : "have"} no uploaded target for ${periodLabel} — ` +
        `their ${Math.round(unmeasured.reduce((sum, s) => sum + s.salesUnits, 0)).toLocaleString()} units are shown ` +
        "in full but are excluded from the headline percentage, which would otherwise be diluted by sales " +
        "nobody set a number for. "
      : "") +
    "Sales that no single area owns — key accounts, chains, wholesale depots — sit in their region's " +
    "own named row and carry no target, so they are never hidden and never inflate an area's " +
    "achievement. " +
    filterCaveat +
    "Units only; this workbook carries no value column. " +
    ATTRIBUTION_CAVEAT;
  note.font = { color: { argb: MUTED }, italic: true, name: "Calibri", size: 9 };
  note.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  sheet.getRow(row).height = 58;

  dressPage(sheet, row, VS_TARGET_COLS);
  sheet.views = [{ state: "frozen", xSplit: 1, showGridLines: false }];
}
