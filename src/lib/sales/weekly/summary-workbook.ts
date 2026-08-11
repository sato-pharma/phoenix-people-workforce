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
import {
  UNITS_FMT,
  VALUE_FMT,
  bandHeader,
  writeTable,
  type CellValue,
} from "@/lib/sales/sales-workbook-kit";
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

/**
 * Keep the brand band pinned while scrolling a long manager list.
 *
 * Assigns a fresh view rather than spreading the existing one: ExcelJS types WorksheetView as a
 * union (normal | frozen | split), so spreading a normal view and stamping state:"frozen" onto it
 * produces a shape that belongs to no member of the union and fails typecheck. bandHeader has
 * already turned gridlines off, and that is the only property worth carrying over, so restating
 * both here is both simpler and type-correct.
 */
function freezeBand(sheet: ExcelJS.Worksheet): void {
  sheet.views = [{ state: "frozen", ySplit: 3, showGridLines: false }];
}

const UNITS_COL = { numFmt: UNITS_FMT, right: true, width: 14 };
const VALUE_COL = { numFmt: VALUE_FMT, right: true, width: 18 };

function totalsRow(leadingBlanks: number, label: string, totals: SummaryTotals): CellValue[] {
  const cells: CellValue[] = [label];
  for (let i = 0; i < leadingBlanks; i += 1) cells.push("");
  return [...cells, totals.salesUnits, totals.salesValue, totals.stockUnits];
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
};

export async function buildWeeklySummaryWorkbook(input: WeeklySummaryInput): Promise<Buffer> {
  const { weekly, mtd, ytd, managerIndex, ytdMonths, periodLabel, generatedAt } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemIdentity.appName;
  workbook.created = new Date();

  const weeklyRows = weekly.factRows ?? [];
  const mtdRows = mtd.factRows ?? [];
  const ytdRows = latestCycleMonthStockOnly(ytd.factRows ?? []);

  buildBranchSheet(workbook, weeklyRows, periodLabel, generatedAt);
  buildManagerSheet(workbook, weeklyRows, managerIndex, periodLabel, generatedAt);
  buildDistributorSheet(workbook, "MTD by Distributor", mtdRows, managerIndex, {
    title: "Month to Date by Distributor",
    subtitle: `Cycle month ${currentCairoCycleMonth()} · all uploaded weeks · Generated ${generatedAt}`,
    unitsLabel: "MTD Units",
    valueLabel: "MTD Value (EGP)",
    stockLabel: "Stock Units",
    note: ATTRIBUTION_CAVEAT,
  });
  buildDistributorSheet(workbook, "YTD by Distributor", ytdRows, managerIndex, {
    title: "Year to Date by Distributor",
    subtitle: `${ytdMonths[0] ?? "—"} to ${currentCairoCycleMonth()} · Generated ${generatedAt}`,
    unitsLabel: "YTD Units",
    valueLabel: "YTD Value (EGP)",
    // Never "YTD Stock": stock is a snapshot, so the only honest YTD stock figure is the latest one.
    stockLabel: "Stock on Hand (latest)",
    note: `${ATTRIBUTION_CAVEAT}  ${ytdCoverageNote(ytdMonths, ytd.factRows ?? [])}`,
  });
  buildLowSalesSheet(workbook, mtdRows, managerIndex, generatedAt);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
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
  rows: WeeklyFactExportRow[],
  periodLabel: string,
  generatedAt: string,
): void {
  const sheet = workbook.addWorksheet("Weekly by Branch");
  bandHeader(
    sheet,
    4,
    "Weekly Sales by Branch",
    `${periodLabel} · this period only, de-cumulated · Generated ${generatedAt}`,
  );
  freezeBand(sheet);

  let row = 5;
  const distributors = rollup(rows, (r) => r.distributorCode, (r) => r.distributorName);

  if (distributors.length === 0) {
    sheet.getCell(row, 1).value = "No validated weekly sales for the selected period.";
    return;
  }

  for (const distributor of distributors) {
    const branchRows = rows.filter((r) => r.distributorCode === distributor.key);
    const branches = rollup(branchRows, (r) => r.branchCode || r.branchName, (r) => r.branchName);
    row = writeTable(sheet, row, {
      title: distributor.label,
      columns: [
        { label: "Branch", width: 38 },
        { label: "Units", ...UNITS_COL },
        { label: "Value (EGP)", dataBar: true, ...VALUE_COL },
        { label: "Stock Units", ...UNITS_COL },
      ],
      rows: branches.map((b) => [b.label, b.salesUnits, b.salesValue, b.stockUnits]),
      totals: [`${distributor.label} — TOTAL`, distributor.salesUnits, distributor.salesValue, distributor.stockUnits],
    });
  }

  const grand = sumRows(rows);
  writeTable(sheet, row, {
    title: "All Distributors",
    columns: [
      { label: "Scope", width: 38 },
      { label: "Units", ...UNITS_COL },
      { label: "Value (EGP)", ...VALUE_COL },
      { label: "Stock Units", ...UNITS_COL },
    ],
    rows: [["Every distributor in this period", grand.salesUnits, grand.salesValue, grand.stockUnits]],
    totals: ["GRAND TOTAL", grand.salesUnits, grand.salesValue, grand.stockUnits],
    note: "Stock is a point-in-time snapshot from each distributor's latest uploaded week — it is never summed across weeks.",
  });
}

// ── Tab 2: Weekly by Manager ──────────────────────────────────────────────────

function buildManagerSheet(
  workbook: ExcelJS.Workbook,
  rows: WeeklyFactExportRow[],
  index: WeeklyManagerIndex,
  periodLabel: string,
  generatedAt: string,
): void {
  const sheet = workbook.addWorksheet("Weekly by Manager");
  bandHeader(
    sheet,
    5,
    "Weekly Uploaded Sales by Manager",
    `${periodLabel} · this period only, de-cumulated · Generated ${generatedAt}`,
  );
  freezeBand(sheet);

  let row = 5;
  const groups = groupRowsByManager(rows, index);

  if (groups.length === 0) {
    sheet.getCell(row, 1).value = "No validated weekly sales for the selected period.";
    return;
  }

  for (const group of groups) {
    const detail = rollup(
      group.rows,
      (r) => `${r.distributorCode}||${r.branchCode || r.branchName}`,
      (r) => r.branchName,
    );
    const branchDistributor = new Map(group.rows.map((r) => [`${r.distributorCode}||${r.branchCode || r.branchName}`, r.distributorName]));
    const totals = sumRows(group.rows);
    const heading = [group.bucket.label, group.bucket.scopeLabel, reportingLine(group.bucket)]
      .filter(Boolean)
      .join("   ·   ");

    row = writeTable(sheet, row, {
      title: heading,
      columns: [
        { label: "Distributor", width: 22 },
        { label: "Branch", width: 34 },
        { label: "Units", ...UNITS_COL },
        { label: "Value (EGP)", dataBar: true, ...VALUE_COL },
        { label: "Stock Units", ...UNITS_COL },
      ],
      rows: detail.map((d) => [
        branchDistributor.get(d.key) ?? "—",
        d.label,
        d.salesUnits,
        d.salesValue,
        d.stockUnits,
      ]),
      totals: totalsRow(1, `${group.bucket.label} — TOTAL`, totals),
    });
  }

  const grand = sumRows(rows);
  writeTable(sheet, row, {
    title: "All Managers",
    columns: [
      { label: "Scope", width: 30 },
      { label: "", width: 26 },
      { label: "Units", ...UNITS_COL },
      { label: "Value (EGP)", ...VALUE_COL },
      { label: "Stock Units", ...UNITS_COL },
    ],
    rows: [["Every manager in this period", "", grand.salesUnits, grand.salesValue, grand.stockUnits]],
    totals: totalsRow(1, "GRAND TOTAL", grand),
    note: ATTRIBUTION_CAVEAT,
  });
}

// ── Tabs 3 + 4: MTD / YTD by Distributor ──────────────────────────────────────

function buildDistributorSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  rows: WeeklyFactExportRow[],
  index: WeeklyManagerIndex,
  labels: { title: string; subtitle: string; unitsLabel: string; valueLabel: string; stockLabel: string; note: string },
): void {
  const sheet = workbook.addWorksheet(sheetName);
  bandHeader(sheet, 4, labels.title, labels.subtitle);
  freezeBand(sheet);

  let row = 5;
  const groups = groupRowsByManager(rows, index);

  if (groups.length === 0) {
    sheet.getCell(row, 1).value = "No validated weekly sales in this period.";
    return;
  }

  for (const group of groups) {
    const distributors = rollup(group.rows, (r) => r.distributorCode, (r) => r.distributorName);
    const totals = sumRows(group.rows);
    const heading = [group.bucket.label, group.bucket.scopeLabel, reportingLine(group.bucket)]
      .filter(Boolean)
      .join("   ·   ");

    row = writeTable(sheet, row, {
      title: heading,
      columns: [
        { label: "Distributor", width: 30 },
        { label: labels.unitsLabel, ...UNITS_COL },
        { label: labels.valueLabel, dataBar: true, ...VALUE_COL },
        { label: labels.stockLabel, ...UNITS_COL },
      ],
      rows: distributors.map((d) => [d.label, d.salesUnits, d.salesValue, d.stockUnits]),
      totals: [`${group.bucket.label} — TOTAL`, totals.salesUnits, totals.salesValue, totals.stockUnits],
    });
  }

  const grand = sumRows(rows);
  writeTable(sheet, row, {
    title: "All Managers",
    columns: [
      { label: "Scope", width: 30 },
      { label: labels.unitsLabel, ...UNITS_COL },
      { label: labels.valueLabel, ...VALUE_COL },
      { label: labels.stockLabel, ...UNITS_COL },
    ],
    rows: [["Every manager in this period", grand.salesUnits, grand.salesValue, grand.stockUnits]],
    totals: ["GRAND TOTAL", grand.salesUnits, grand.salesValue, grand.stockUnits],
    note: labels.note,
  });
}

// ── Tab 5: Critical low-sales branches with stock ─────────────────────────────

function buildLowSalesSheet(
  workbook: ExcelJS.Workbook,
  rows: WeeklyFactExportRow[],
  index: WeeklyManagerIndex,
  generatedAt: string,
): void {
  const sheet = workbook.addWorksheet("Low Sales With Stock");
  bandHeader(
    sheet,
    5,
    "Critical — Low Sales With Stock On Hand",
    `Cycle month ${currentCairoCycleMonth()} · 0-5 units sold with stock remaining · field managers only, Head Office excluded · Generated ${generatedAt}`,
  );
  freezeBand(sheet);

  // One section per manager, managers one under another with their own subtotal — the same shape as
  // the manager/MTD/YTD tabs. This is an action list a manager reads about THEIR OWN branches, so a
  // flat table with a manager column would make each of them hunt for their rows.
  const byBranch = new Map<
    string,
    { manager: WeeklyManagerBucket; distributorName: string; branchName: string } & SummaryTotals
  >();
  for (const row of rows) {
    const manager = resolveWeeklyManager(index, row.line, row.regionCode);
    const key = `${manager.key}||${row.distributorCode}||${row.branchCode || row.branchName}`;
    const existing =
      byBranch.get(key) ?? {
        manager,
        distributorName: row.distributorName,
        branchName: row.branchName || row.branchCode,
        ...ZERO,
      };
    addInto(existing, row);
    byBranch.set(key, existing);
  }

  const flagged = [...byBranch.values()].filter(
    (entry) =>
      isActionableLowSalesBucket(entry.manager.kind) &&
      isLowSalesWithStock(entry.salesUnits, entry.stockUnits),
  );

  if (flagged.length === 0) {
    sheet.getCell(5, 1).value = "No branch is holding stock with 0-5 units sold this month.";
    return;
  }

  const sections = new Map<string, { manager: WeeklyManagerBucket; entries: typeof flagged }>();
  for (const entry of flagged) {
    const section = sections.get(entry.manager.key);
    if (section) section.entries.push(entry);
    else sections.set(entry.manager.key, { manager: entry.manager, entries: [entry] });
  }

  let row = 5;
  for (const section of [...sections.values()].sort((a, z) => compareManagerBuckets(a.manager, z.manager))) {
    // Worst first: fewest units sold, then most stock sitting there.
    const entries = section.entries.sort(
      (a, z) => a.salesUnits - z.salesUnits || z.stockUnits - a.stockUnits || a.branchName.localeCompare(z.branchName),
    );
    const totals = entries.reduce<SummaryTotals>(
      (acc, entry) => ({
        salesUnits: acc.salesUnits + entry.salesUnits,
        salesValue: acc.salesValue + entry.salesValue,
        stockUnits: acc.stockUnits + entry.stockUnits,
      }),
      { ...ZERO },
    );
    const heading = [section.manager.label, section.manager.scopeLabel, reportingLine(section.manager)]
      .filter(Boolean)
      .join("   ·   ");

    row = writeTable(sheet, row, {
      title: `${heading}   —   ${entries.length} branch${entries.length === 1 ? "" : "es"}`,
      columns: [
        { label: "Distributor", width: 22 },
        { label: "Branch", width: 34 },
        { label: "Sales Units", ...UNITS_COL },
        { label: "Sales Value (EGP)", ...VALUE_COL },
        { label: "Stock Units", dataBar: true, ...UNITS_COL },
      ],
      rows: entries.map((entry) => [
        entry.distributorName,
        entry.branchName,
        entry.salesUnits,
        entry.salesValue,
        entry.stockUnits,
      ]),
      totals: totalsRow(1, `${section.manager.label} — TOTAL`, totals),
    });
  }

  const grand = flagged.reduce<SummaryTotals>(
    (acc, entry) => ({
      salesUnits: acc.salesUnits + entry.salesUnits,
      salesValue: acc.salesValue + entry.salesValue,
      stockUnits: acc.stockUnits + entry.stockUnits,
    }),
    { ...ZERO },
  );
  writeTable(sheet, row, {
    title: `All Managers — ${flagged.length} branch${flagged.length === 1 ? "" : "es"} holding stock they are not selling`,
    columns: [
      { label: "Scope", width: 22 },
      { label: "", width: 34 },
      { label: "Sales Units", ...UNITS_COL },
      { label: "Sales Value (EGP)", ...VALUE_COL },
      { label: "Stock Units", ...UNITS_COL },
    ],
    rows: [["Every manager this month", "", grand.salesUnits, grand.salesValue, grand.stockUnits]],
    totals: totalsRow(1, "GRAND TOTAL", grand),
    note:
      "Sorted worst-first within each manager: fewest units sold, then most stock held. " +
      "Head Office is excluded from this tab (no field manager to action it) — it is still included " +
      "in the Weekly by Manager, MTD and YTD tabs. " +
      "Distributors that do not report stock at all (POS, Direct) can never appear here. " +
      ATTRIBUTION_CAVEAT,
  });
}
