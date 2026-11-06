/**
 * Has a published month's FROZEN wholesaler split drifted away from what the rule says today?
 *
 * WHY THIS EXISTS. `au.monthly_store_split_net` is written once and then frozen for any period
 * holding a live publication row, which is correct — a published and announced month is never
 * corrected. But the rule behind it keeps moving: every owner ruling that adds a key to
 * STORE_OVERRIDE_CUSTOMER_KEYS re-answers "is this customer a warehouse" for every period at once.
 * Nothing said when the frozen photograph stopped matching the rule. This does.
 *
 * 🔴 IT COMPARES BY VALUE, NEVER BY UNITS, and that is the point rather than a preference. The
 * split is unit-preserving by construction — both nets sum to zero per product — so every
 * difference printed here totals zero units. The publication drift check misses all of it because
 * its snapshot is built from `source_of_sales_fact_rollup` and the split net never enters that
 * table, NOT because of its grain: it already compares per cell, units and value. See
 * src/lib/sales/store-split-drift.ts.
 *
 * 🔴 THIS SCRIPT SEES ONE LAYER. For "has a published month moved, across BOTH layers, and which
 * areas hold it", run scripts/check-closing-publication-drift.ts, which folds this report into the
 * publication check per published line.
 *
 * 🔴 IT REPORTS, IT NEVER WRITES, AND IT EXITS 0 EVEN WHEN IT FINDS DRIFT. Rebuilding a published
 * month's net restates an announced number, which is the owner's decision alone. Pass
 * `--fail-on-drift` to make it exit 2 instead, for a caller that deliberately wants a gate — but
 * think first: a check that fires at the normal working level becomes wallpaper, and this one is
 * expected to be non-empty until the owner decides a month should be rebuilt.
 *
 * WHICH PERIODS. By default every period that is both split-active and PUBLISHED — the only ones
 * the freeze can strand. Name periods to override, or pass `--all` for every period on record
 * (unpublished ones recompute live anyway, so drift there means the net was simply never written).
 *
 * Usage (from the repo root, with a populated .env.local — this READS PRODUCTION):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/check-store-split-drift.ts [--all] [--fail-on-drift] [period ...]
 */
import { isStoreCitySplitActive } from "@/lib/sales/store-sales-city-split";
import { loadStoreSplitDrift, type StoreSplitDriftReport } from "@/lib/sales/store-split-drift";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertTreeIsCurrent } from "./lib/tree-is-current.ts";

const argv = process.argv.slice(2);
const includeAll = argv.includes("--all");
const failOnDrift = argv.includes("--fail-on-drift");
const requested = argv.filter((arg) => /^\d{4}-\d{2}$/.test(arg));

// An unknown flag is REFUSED rather than ignored: an ignored flag runs different behaviour from the
// one the operator asked for while reporting success.
const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--all" && arg !== "--fail-on-drift");
if (unknown.length > 0) {
  console.error(`check-store-split-drift: unknown flag(s) ${unknown.join(", ")} — refusing to run`);
  process.exit(64);
}

// This script recomputes the rule from the code in THIS tree and its verdict gets quoted, so a
// tree behind origin/main reports drift (or calm) about pre-merge code. Refused, with an override.
assertTreeIsCurrent("check-store-split-drift");

const supabase = getSupabaseAdmin();

async function publishedPeriods(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("monthly_closing_publications")
    .select("period")
    .is("unpublished_at", null);
  if (error) throw error;
  const periods = new Set<string>();
  for (const row of (data ?? []) as { period?: string | null }[]) {
    const period = String(row?.period ?? "").trim();
    if (/^\d{4}-\d{2}$/.test(period)) periods.add(period);
  }
  return periods;
}

async function periodsOnRecord(): Promise<string[]> {
  // Paged: one batch per distributor per month outgrows a single 1,000-row read, and a period dropped here is never checked.
  const data = await fetchAllRows<{ period?: string | null }>(
    () => supabase.from("source_of_sales_import_batches").select("period").eq("status", "validated"),
    "id",
  );
  const periods = new Set<string>();
  for (const row of data) {
    const period = String(row?.period ?? "").trim();
    if (/^\d{4}-\d{2}$/.test(period)) periods.add(period);
  }
  return [...periods].sort();
}

function money(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function print(report: StoreSplitDriftReport, published: boolean): void {
  const tag = published ? "PUBLISHED (frozen)" : "unpublished (live)";
  if (!report.drifted) {
    console.log(`${report.period}  ${tag}  —  no drift. ${report.frozenCells} frozen cells match the rule.`);
    return;
  }
  console.log(`${report.period}  ${tag}  —  DRIFTED`);
  console.log(
    `  ${report.cells.length} cell(s) across ${report.byArea.length} line x area pair(s); `
    + `frozen ${report.frozenCells} cells vs live ${report.liveCells}`,
  );
  // TWO figures, because one alone is ambiguous on a money report and they are not the same thing.
  // The cell figure is gross: an area can hold offsetting cells on different products, and those
  // cancel in the rollup. The area figure is the money that actually ends up on a different area,
  // which is the one that moves an achievement. Measured July 2026: 376,315.42 gross against
  // 352,549.49 net, so the gap is real and worth naming rather than picking a favourite.
  const areaValueDelta = report.byArea.reduce((sum, area) => sum + Math.max(0, area.valueDelta), 0);
  console.log(`  ${money(areaValueDelta)} EGP ends up on a different area`);
  console.log(
    `  ${money(report.absoluteValueDelta / 2)} EGP moved each way at cell grain `
    + `(${money(report.absoluteValueDelta)} absolute — the difference from the line above is cells `
    + "that offset inside one area)",
  );
  // Printed every time, not only when it fails: an operator reading a drift report needs to know
  // the difference is a redistribution rather than money appearing from nowhere.
  console.log(
    `  sum of differences ${money(report.valueDeltaSum)}`
    + (Math.abs(report.valueDeltaSum) < 0.005
      ? " — balanced, so this is a redistribution between areas"
      : " — 🔴 NOT BALANCED: one of the two nets does not sum to zero, which is a worse fault than drift"),
  );
  if (report.lineUnitTotalsAgree) {
    console.log("  every line's total net units AGREE — the units-based publication drift check cannot see any of this");
  }
  for (const area of report.byArea) {
    const sign = area.valueDelta > 0 ? "+" : "";
    console.log(
      `    ${area.lineCode.padEnd(15)} ${area.areaCode.padEnd(6)} ${(sign + money(area.valueDelta)).padStart(16)}`
      + `   ${area.cells} cell(s)`,
    );
  }
}

async function main(): Promise<void> {
  const published = await publishedPeriods();
  const candidates = requested.length > 0
    ? [...new Set(requested)].sort()
    : (await periodsOnRecord()).filter(
      (period) => isStoreCitySplitActive(period) && (includeAll || published.has(period)),
    );

  if (candidates.length === 0) {
    console.log("no periods to check — nothing is both split-active and published (try --all, or name a period)");
    return;
  }

  console.log(`checking ${candidates.length} period(s): ${candidates.join(", ")}\n`);
  let drifted = 0;
  for (const period of candidates) {
    if (!isStoreCitySplitActive(period)) {
      console.log(`${period}  before the store city split starts — nothing to compare, its net is empty by design`);
      continue;
    }
    const report = await loadStoreSplitDrift(period);
    print(report, published.has(period));
    if (report.drifted) drifted += 1;
    console.log("");
  }

  if (drifted === 0) {
    console.log("No drift anywhere. Every frozen net still matches what the rule computes today.");
    return;
  }
  console.log(`${drifted} period(s) drifted.`);
  console.log("Rebuilding a published month's net restates an announced number — that is the OWNER's call:");
  console.log("  he unpublishes the period, then scripts/backfill-attribution-store-split.ts --apply <period>,");
  console.log("  then select au.f_refresh_monthly_attribution('<period>'), then he re-publishes.");
  if (failOnDrift) process.exit(2);
}

await main();
