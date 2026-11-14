// ─────────────────────────────────────────────────────────────────────────────
// Runs the sales reconciliation against live data. SERVER-ONLY — it reaches the database.
//
// The arithmetic is in ./sales-truth-reconciliation.ts and is pure, so the suite can prove the
// comparator fires without a network round trip. This file only fetches, and it fetches through
// the REAL loaders each surface uses — never a re-implementation of them. A guard that re-derives
// what it is checking proves only that the guard agrees with itself.
//
// TWO SURFACES ARE COMPARED AGAINST MONTHLY CLOSING:
//
//   1. "Sales vs Target" — loadAchievementRange, i.e. phx_sales_vs_target_range. This one function
//      feeds /sales/vs-target, the employee portal, employee-360, the business review, SFE team
//      performance and the canonical admin dashboard, so one finding here is a finding on all six.
//
//   2. "Source of Sales" — the area each sale is filed under in the import rollup, which is what
//      the Source of Sales screen renders. Distributor money comes from the closing's own
//      phx_closing_distributor_product (identical predicates, areas untouched); direct money is
//      read from source_of_sales_fact_rollup, because phx_monthly_closing_direct blanks the area
//      for the overlay-owned months — July 2026 alone since 2026-09-01, every month before
//      2026-08 before that — and would therefore hide the very attribution this surface exists to
//      check.
//
// ── WHY THE DELIBERATE TRANSFORMS ARE NORMALISED AWAY, NOT REPORTED ──────────────────────────
// Monthly Closing applies three transforms the database knows nothing about, and every one of them
// is CORRECT: the owner's hand-mapped July direct orders, the Fayoum/Beni Suef area merge, and the
// store city split. A comparison that reported those would fire ~35 findings worth 2.5M EGP on a
// month whose numbers are all right — and a guard that cries wolf on the owner's own decisions is
// worse than no guard, because the real finding underneath it stops being read. So both sides go
// through applyAchievementAreaMerges, each row AS OF ITS OWN MONTH, and the Source of Sales side
// gets the store split from the closing's own splitter (loadClosingStoreSplitNet — the net the
// matrix itself adds). The owner's July direct overlay is the ONE transform deliberately left
// un-normalised: it is the repair the database is missing, so applying it to the database side
// would turn the one real defect in this month into a green tick. What survives is only what
// nobody declared.
//
// Until 2026-09-21 this header claimed the split was already read from the closing's splitter, and
// it was not: the Source of Sales side compared the rows as filed against a matrix that had the
// split. July agreed only because the split starts at 2026-08. August then reported 105 areas and
// 4,599,761.25 EGP misplaced — El Qema's 1,797,120.00 EGP filed on Pedia Qalubeya alone, which the
// closing spreads over the republic by its warehouse rule. The same run left Pedia Beni Suef
// unfolded, because the merge was asked "as of now" (September, when Pedia's fold has ended) about
// an August that the closing folds.
//
// The three Monthly Closing surfaces — screen, frozen XLSX, premium .xlsm — are deliberately NOT
// compared against each other here. They all call loadMonthlyClosingPartsWithStoreSplit, so they
// share one matrix by construction, and the workbook rendering is already pinned by
// tests/closing-export-matches-screen.test.ts. Re-checking them at runtime would cost two workbook
// builds to re-prove a shared reference.
// ─────────────────────────────────────────────────────────────────────────────

import { RESTRICTED_PRODUCT_CODES } from "@/lib/sales/access-scope";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import { loadClosingStoreSplitNet } from "@/lib/sales/closing-store-split-net";
import {
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
} from "@/lib/sales/monthly-distributor-import";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import {
  type SalesAreaTotals,
  type SalesTruthReport,
  achievementAreaTotals,
  applyStoreSplitNetToTotals,
  closingAreaTotals,
  reconcileAreaTotals,
} from "@/lib/sales/sales-truth-reconciliation";
import { SURFACE_VS_TARGET } from "@/lib/sales/sales-truth-declared";
import { loadAchievementRange } from "@/lib/sales/vs-target";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

export { SURFACE_VS_TARGET };
export const SURFACE_SOURCE_OF_SALES = "Source of Sales";

/**
 * The confidential products every closing RPC drops in SQL. Taken from the one constant the rest of
 * the app uses rather than re-typed, because the direct half is read from the rollup instead of
 * through the RPC — so if this list ever grows, this guard has to follow it or it starts reporting
 * a product the closing legitimately cannot see. `tests/sales-truth-no-mismatch.test.ts` pins that
 * it is the shared constant and not a copy.
 */
const CONFIDENTIAL_PRODUCT_CODES = new Set<string>(RESTRICTED_PRODUCT_CODES);

/** A rollup row we could not attribute to a validated batch is not in any closing either. */
type DirectRollupRow = {
  officialLine: string;
  areaCode: string;
  productCode: string;
  directValue: number;
};

function upper(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function addTo(totals: SalesAreaTotals, lineCode: string, areaCode: string, salesValue: number): void {
  const line = lineCode.trim().toLowerCase();
  const area = upper(areaCode) || "(UNATTRIBUTED)";
  const key = `${line}|${area}`;
  const existing = totals.get(key);
  if (existing) {
    existing.salesValue += salesValue;
    return;
  }
  totals.set(key, { lineCode: line, areaCode: area, salesValue });
}

function mergeInto(target: SalesAreaTotals, source: SalesAreaTotals): void {
  for (const [key, total] of source) {
    const existing = target.get(key);
    if (!existing) {
      target.set(key, { ...total });
      continue;
    }
    existing.salesValue += total.salesValue;
    // Keep the first name found. Lines do not share keys today, but a merge that dropped a label
    // would print a bare code to the owner, which is the one thing he has ruled out.
    existing.lineName ||= total.lineName;
    existing.areaName ||= total.areaName;
    existing.regionName ||= total.regionName;
  }
}

/**
 * Every direct rollup row for one month, as the Source of Sales screen sees it.
 *
 * Read in two steps rather than one join: the validated batch ids for the month first (a handful),
 * then the rollup rows carrying them. A PostgREST `.in()` silently returns nothing once it carries
 * a few hundred ids, so the batch list is chunked; and the row read asks for an exact count so a
 * truncated page can never be mistaken for "that is all the direct sales there were".
 */
async function loadDirectRollupRows(period: string): Promise<DirectRollupRow[]> {
  const supabase = getSupabaseAdmin();
  const { data: batches, error: batchError } = await supabase
    .from("source_of_sales_import_batches")
    .select("id")
    .eq("period", period)
    .eq("status", "validated");
  if (batchError) throw batchError;

  const batchIds = (batches ?? []).map((row) => String((row as Record<string, unknown>).id));
  if (batchIds.length === 0) return [];

  const rows: DirectRollupRow[] = [];
  for (let index = 0; index < batchIds.length; index += 50) {
    const chunk = batchIds.slice(index, index + 50);
    const { data, error, count } = await supabase
      .from("source_of_sales_fact_rollup")
      .select("official_line,area_code,product_code,direct_value", { count: "exact" })
      .eq("period", period)
      .eq("is_direct", true)
      .in("batch_id", chunk)
      .order("id", { ascending: true })
      .limit(5000);
    if (error) throw error;
    const returned = data ?? [];
    if (typeof count === "number" && count > returned.length) {
      throw new Error(
        `sales-truth: direct rollup read truncated for ${period} (${returned.length} of ${count} rows) — raise the page size rather than reporting a partial month`,
      );
    }
    for (const row of returned) {
      const record = row as Record<string, unknown>;
      const productCode = upper(record.product_code);
      if (CONFIDENTIAL_PRODUCT_CODES.has(productCode)) continue;
      rows.push({
        officialLine: String(record.official_line ?? "").trim(),
        areaCode: String(record.area_code ?? "").trim(),
        productCode,
        directValue: Number(record.direct_value ?? 0),
      });
    }
  }
  return rows;
}

/**
 * Per-area money as the DATABASE files it — the Source of Sales view — with the closing's own store
 * split added on top.
 *
 * Distributor half straight from the closing's own RPC (same predicates, areas untouched); direct
 * half from the rollup exactly as it is stored, overlay and all repairs deliberately withheld. Then
 * the store split, read through loadClosingStoreSplitNet: the SAME net
 * loadMonthlyClosingPartsWithStoreSplit adds to the matrix this is compared with, for the same line
 * and month, and empty wherever the closing applies none (every month before 2026-08, and any line
 * the split never touches). Never a re-implementation of the rule — a guard that re-derives the
 * split proves only that it agrees with itself.
 */
async function loadSourceOfSalesAreaTotals(input: {
  line: string;
  lineCode: string;
  period: string;
  directRows: readonly DirectRollupRow[];
}): Promise<SalesAreaTotals> {
  const supabase = getSupabaseAdmin();
  const distributor = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_closing_distributor_product",
    { p_line: input.line, p_period: input.period },
    ["distributor_code", "region_code", "area_code", "product_code"],
  );

  const totals: SalesAreaTotals = new Map();
  for (const row of distributor) addTo(totals, input.lineCode, String(row.area_code ?? ""), Number(row.value ?? 0));

  const lineKey = input.line.trim().toLowerCase();
  // The database's OWN attribution, verbatim — the owner's July overlay is deliberately NOT
  // applied here even though this file can see it.
  //
  // Applying it would make this surface pass by doing, in the guard, the very repair the database
  // is missing: the overlay's line totals reconcile to the rollup exactly, so substituting its
  // areas turns the one real defect into a green tick. The Source of Sales screen has no overlay —
  // it renders `area_code` as it finds it, which is why an unstamped direct row shows there as
  // "Unmapped". Reporting that gap is the entire job.
  for (const row of input.directRows) {
    if (row.officialLine.toLowerCase() !== lineKey) continue;
    addTo(totals, input.lineCode, row.areaCode, row.directValue);
  }

  // The store city split and El Qema's warehouse rule are the closing's decisions, not the
  // database's, so the rows above know nothing of them. Pedia August files 1,797,120.00 EGP of El
  // Qema on Qalubeya that the closing spreads over the republic; leaving the split out reported that
  // one decision as 105 misplaced areas. What this cannot land is left in on purpose — see
  // applyStoreSplitNetToTotals.
  const storeSplitNet = await loadClosingStoreSplitNet(input.line, input.period);
  return applyStoreSplitNetToTotals(totals, input.lineCode, storeSplitNet);
}

/**
 * Fold the Fayoum/Beni Suef style merges into a totals map so both sides share one area vocabulary.
 *
 * AS OF THE MONTH BEING CHECKED. Every merge rule is dated, and a row without a period is resolved
 * as of today — so an August checked in September lost Pedia's fold (it ends with August) while the
 * closing kept it, and reported Beni Suef as money the closing never booked.
 */
function applyMergesToTotals(totals: SalesAreaTotals, period: string): SalesAreaTotals {
  const asRows = [...totals.values()].map((total) => ({
    lineCode: total.lineCode,
    areaCode: total.areaCode,
    period,
    salesValue: total.salesValue,
  }));
  const merged: SalesAreaTotals = new Map();
  for (const row of applyAchievementAreaMerges(asRows)) {
    addTo(merged, row.lineCode ?? "", row.areaCode ?? "", row.salesValue);
  }
  return merged;
}

/**
 * Reconcile every surface against Monthly Closing for one month.
 *
 * A line whose closing cannot be read is reported in `unreadableLines` and its areas are left out
 * of the comparison entirely — never folded in as zeros, which would manufacture a finding on
 * every area of that line and bury the real ones.
 */
export async function loadSalesTruthReport(period?: string | null): Promise<SalesTruthReport> {
  const periods = await listMonthlyClosingPeriods();
  return loadSalesTruthReportForPeriod(period && periods.includes(period) ? period : periods[0] ?? null);
}

/**
 * One named month, or null when that month has no closing at all. Unlike loadSalesTruthReport it never
 * falls back to the newest month: the daily check asks about one month by name, and an answer about a
 * different month would be filed under the wrong one.
 */
export async function loadSalesTruthReportForMonth(period: string): Promise<SalesTruthReport | null> {
  const periods = await listMonthlyClosingPeriods();
  return periods.includes(period) ? loadSalesTruthReportForPeriod(period) : null;
}

/** Every month that has a closing, newest first, exactly as the closing lists them. */
export async function listSalesTruthMonths(): Promise<string[]> {
  return listMonthlyClosingPeriods();
}

/**
 * Every month that has closing data, oldest first — the sweep the guard actually runs on.
 *
 * The page shows one month because a month costs three closing loads; the CLI and any cron sweep
 * ALL of them, because "the current month agrees" is not the question the owner asked. On the day
 * this was written the running month was clean and the published one was not, so a single-month
 * green would have been a false all-clear.
 */
export async function loadSalesTruthReports(): Promise<SalesTruthReport[]> {
  const periods = await listMonthlyClosingPeriods();
  const reports: SalesTruthReport[] = [];
  // Sequential on purpose: each period loads three closings, and running them all at once is how
  // a 16 GB laptop and a 1-replica service both fall over.
  for (const period of [...periods].sort()) {
    reports.push(await loadSalesTruthReportForPeriod(period));
  }
  return reports;
}

async function loadSalesTruthReportForPeriod(selectedPeriod: string | null): Promise<SalesTruthReport> {
  const lines = await listMonthlyClosingLines();

  if (!selectedPeriod) {
    return { period: "", ok: true, surfaces: [], unreadableLines: [], generatedAt: new Date().toISOString() };
  }

  const directRows = await loadDirectRollupRows(selectedPeriod);
  const truth: SalesAreaTotals = new Map();
  const sourceOfSales: SalesAreaTotals = new Map();
  const unreadableLines: string[] = [];

  for (const line of lines) {
    const lineCode = resolveTargetLineCode(line);
    // A line with no target code is Head Office, deliberately outside every closing and every
    // achievement figure (owner's golden rule). Comparing it would report the whole line as
    // missing on both surfaces, every month, for ever.
    if (!lineCode) continue;

    try {
      const parts = await loadMonthlyClosingPartsWithStoreSplit({ line, period: selectedPeriod });
      // The loader falls back to its newest month when the requested one has no data. Accepting
      // that silently would reconcile a different month against this one's achievement rows and
      // report the entire company as mismatched.
      if (parts.combined.period !== selectedPeriod) {
        unreadableLines.push(line);
        continue;
      }
      mergeInto(truth, closingAreaTotals(parts.combined, lineCode, line));
      mergeInto(sourceOfSales, await loadSourceOfSalesAreaTotals({ line, lineCode, period: selectedPeriod, directRows }));
    } catch {
      unreadableLines.push(line);
    }
  }

  const achievement = achievementAreaTotals(
    applyAchievementAreaMerges(await loadAchievementRange(selectedPeriod, selectedPeriod)),
  );

  const surfaces = [
    reconcileAreaTotals({ surface: SURFACE_VS_TARGET, truth, candidate: achievement }),
    reconcileAreaTotals({
      surface: SURFACE_SOURCE_OF_SALES,
      truth,
      candidate: applyMergesToTotals(sourceOfSales, selectedPeriod),
    }),
  ];

  return {
    period: selectedPeriod,
    ok: surfaces.every((surface) => surface.ok) && unreadableLines.length === 0,
    surfaces,
    unreadableLines,
    generatedAt: new Date().toISOString(),
  };
}
