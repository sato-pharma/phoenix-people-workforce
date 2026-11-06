/**
 * One-off backfill: write au.monthly_store_split_net for periods that already exist.
 *
 * WHY IT IS NEEDED AT ALL. The net is written by the import paths, so it only appears for a period
 * when something imports or reconciles into it. Every month already on record therefore has an EMPTY
 * net, and au.f_monthly_attribution keeps returning what it returned before the split reached it —
 * safe, but not the fix. This writes the net for those months once, so Sales vs Target starts
 * agreeing with the Monthly Closing about which area a wholesaler's units belong to.
 *
 * It is NOT a repair tool and does not need to be re-run: after this, every import maintains the net
 * on its own (see attribution-store-split-refresh.ts). It is idempotent and safe to re-run anyway —
 * phx_write_monthly_store_split_net replaces a period wholesale, and the computation is a pure
 * function of the closing detail rows.
 *
 * WHICH PERIODS. Any period one of the three rules covers — the Office respread from 2026-01 (owner,
 * 2026-10-13), the city split from `STORE_CITY_SPLIT_FROM_PERIOD` and the EPDA-BULK allocation. The
 * city split itself starts at `STORE_CITY_SPLIT_FROM_PERIOD` — 2026-07
 * since the owner's 2026-10-02 "FIX JULY" ruling — so anything earlier produces an empty net by
 * construction and is skipped rather than written. Within a period the PER-LINE warehouse gate still
 * applies — Pedia uses the 2026-09 rulings from August, every other line does not until September —
 * and that is decided inside the split, not here.
 *
 * 🔴 A PUBLISHED PERIOD IS REFUSED, SILENTLY-ISH. `phx_write_monthly_store_split_net` returns 0 and
 * raises a NOTICE (not an error) for any period holding a live `monthly_closing_publications` row —
 * the freeze of 20260927213000. So running this for July while July is published writes NOTHING and
 * reports success. Unpublish the period first, then re-stamp the rollup afterwards.
 *
 * 🔴 THIS SCRIPT DOES NOT REFRESH THE ATTRIBUTION ROLLUP. Writing the net changes what
 * au.f_monthly_attribution RETURNS, but au.f_monthly_achievement serves the materialised
 * au.monthly_attribution_rollup while its config fingerprint still matches. The fingerprint covers
 * the net, so writing it makes every period fall back to the live computation — correct numbers,
 * just slower — until someone re-stamps. Run this afterwards, once, as the operator:
 *   select au.f_rebuild_monthly_attribution_all();
 * Deliberately left out of the script: a bulk rebuild of every period is an operator decision with
 * its own before/after check, not a side effect of a backfill.
 *
 * Usage (from the repo root, with a populated .env.local — this reads and writes PRODUCTION):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/backfill-attribution-store-split.ts [--apply] [period ...]
 *
 * Without --apply it computes and prints everything and writes NOTHING.
 */
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { systemAccessContext } from "@/lib/auth/permissions";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { loadSplitRegions } from "@/lib/sales/closing-organogram-regions";
import { isBulkAllocationActive } from "@/lib/sales/bulk-allocation-channel";
import { isOfficeRespreadActive } from "@/lib/sales/office-distributor";
import { isStoreCitySplitActive } from "@/lib/sales/store-sales-city-split";
import {
  ATTRIBUTION_SPLIT_LINES,
  buildStoreSplitNetPayload,
  type AttributionSplitRow,
  type StoreSplitNetPayloadRow,
} from "@/lib/sales/attribution-store-split-net";
import { assertTreeIsCurrent } from "./lib/tree-is-current.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "backfill-attribution-store-split",
  entry: import.meta.url,
  known: ["--apply"],
});

const apply = process.argv.includes("--apply");
const requested = process.argv.slice(2).filter((arg) => /^\d{4}-\d{2}$/.test(arg));

// This script recomputes the rule from the code in THIS tree, so a tree behind origin/main
// produces pre-merge numbers (and, with --apply, writes them). Refused, with an override.
assertTreeIsCurrent("backfill-attribution-store-split");

const supabase = getSupabaseAdmin();

async function periodsToBackfill(): Promise<string[]> {
  if (requested.length > 0) return [...new Set(requested)].sort();
  // Every period on record; the split's own start date filters the rest out below.
  // Paged: one batch per distributor per month outgrows a single 1,000-row read, and a period dropped here is never backfilled.
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

async function rowsForLine(line: string, period: string): Promise<readonly AttributionSplitRow[]> {
  // The REAL areas, not the "Fayoum - Beni Suef" display fold: this net is added to
  // au.monthly_attribution_rollup, which keys on the real area. See keepMergedAreasApart.
  const details = await loadMonthlyClosingDetails({
    keepMergedAreasApart: true,
    access: systemAccessContext,
    line,
    period,
    availableLines: [line],
    availablePeriods: [period],
    includeConfidential: false,
    unpaged: true,
  });
  return details.rows;
}

function report(period: string, line: string, rows: StoreSplitNetPayloadRow[]): void {
  if (rows.length === 0) {
    console.log(`  ${line.padEnd(15)} nothing moves`);
    return;
  }
  const moved = rows.filter((row) => row.net_qty > 0).reduce((sum, row) => sum + row.net_qty, 0);
  const netQty = rows.reduce((sum, row) => sum + row.net_qty, 0);
  const netEff = rows.reduce((sum, row) => sum + row.net_effective_units, 0);
  const areas = new Set(rows.map((row) => row.area_code)).size;
  console.log(
    `  ${line.padEnd(15)} ${String(rows.length).padStart(4)} cells across ${String(areas).padStart(3)} areas, `
    + `${moved.toFixed(3).padStart(12)} units relocated  (net qty ${netQty.toExponential(1)}, `
    + `net eff ${netEff.toExponential(1)})`,
  );
  // The invariant, restated at the point a human reads it. The database refuses an unbalanced net
  // anyway; printing it here means an operator sees the proof rather than trusting the refusal.
  if (Math.abs(netQty) > 1e-9 || Math.abs(netEff) > 1e-9) {
    throw new Error(`${period} ${line}: net does not balance to zero — refusing to continue`);
  }
}

async function main(): Promise<void> {
  const periods = await periodsToBackfill();
  console.log(
    `${apply ? "APPLYING" : "DRY RUN — nothing will be written"}: `
    + `${periods.length} period(s) on record\n`,
  );

  for (const period of periods) {
    // The SAME three-rule gate writeStoreSplitNetForPeriods uses: the city split (2026-07), the
    // EPDA-BULK allocation (2026-09) and the Office respread (2026-01 since his 2026-10-13 ruling).
    // Gating on the city split alone skipped January–June, whose net now carries the Office respread.
    if (!isStoreCitySplitActive(period) && !isBulkAllocationActive(period) && !isOfficeRespreadActive(period)) {
      console.log(`${period}: before every split rule starts — skipped, net stays empty`);
      continue;
    }
    console.log(`${period}:`);
    const payload: StoreSplitNetPayloadRow[] = [];
    for (const line of ATTRIBUTION_SPLIT_LINES) {
      const regions = await loadSplitRegions(line, period);
      const rows = buildStoreSplitNetPayload(
        line,
        await rowsForLine(line, period),
        period,
        regions,
      );
      report(period, line, rows);
      payload.push(...rows);
    }

    if (!apply) {
      console.log(`  -> would write ${payload.length} row(s)\n`);
      continue;
    }
    const { data, error } = await supabase.rpc("phx_write_monthly_store_split_net", {
      p_period: period,
      p_rows: payload,
    });
    if (error) throw new Error(`${period}: write failed — ${error.message}`);
    console.log(`  -> wrote ${data} row(s)\n`);
  }

  if (apply) {
    console.log("Net written. NOW RE-STAMP THE ROLLUP, or every period stays on the slow live path:");
    console.log("  select au.f_rebuild_monthly_attribution_all();");
  }
}

await main();
